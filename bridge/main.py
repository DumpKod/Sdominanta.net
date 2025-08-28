from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Dict
import yaml
import os
# Меняем импорт SdominantaAgent на новый путь
from pa2ap.agent import SdominantaAgent
import asyncio
import httpx
from pydantic import BaseModel
from pynostr.event import Event, EventKind
from bridge.api.wall import WallAPI # Импортируем WallAPI
import json

app = FastAPI()

# Инициализация WallAPI
wall_api = WallAPI()

connected_websockets: set[WebSocket] = set() # Глобальный набор для хранения активных WebSocket-соединений

async def handle_p2p_message(msg: str):
    global known_peers
    global connected_websockets
    print(f"[SERVER AGENT RECEIVED]: {msg}")
    try:
        data = json.loads(msg)
        if data[0] == "EVENT":
            event_data = data[2]
            event_pubkey = event_data.get("pubkey")
            if event_pubkey and event_pubkey not in known_peers:
                known_peers.add(event_pubkey)
                print(f"Added new peer to known_peers: {event_pubkey}")
            
            # Отправляем P2P событие всем подключенным WebSocket-клиентам
            for websocket in connected_websockets:
                await websocket.send_json({"type": "p2p_event", "data": event_data})

    except json.JSONDecodeError:
        print(f"Could not decode JSON from P2P message: {msg}")
    except Exception as e:
        print(f"Error processing P2P message: {e}")


# Удаляем GemmaRequest, так как Gemma теперь управляется напрямую
# class GemmaRequest(BaseModel):
#     prompt: str

# Загрузка конфигурации
CONFIG = {}
config_path = os.getenv("BRIDGE_CONFIG_PATH", "Sdominanta.net/bridge/config.yaml")
try:
    with open(config_path, 'r') as f:
        CONFIG = yaml.safe_load(f)
except FileNotFoundError:
    print(f"Warning: Config file not found at {config_path}. Using default settings.")

# Инициализация SdominantaAgent (если P2P включен)
sdominanta_agent: SdominantaAgent = None
# Приватный ключ агента для сервера. В продакшене использовать Docker Secrets.
SERVER_AGENT_PRIVATE_KEY = os.getenv("SERVER_AGENT_PRIVATE_KEY", None)
known_peers: set[str] = set() # Глобальный набор для хранения известных публичных ключей пиров

if CONFIG.get('p2p_enabled', False):
    daemon_url = os.getenv("P2P_WS_URL", "ws://127.0.0.1:9090")
    # Инициализируем SdominantaAgent с приватным ключом сервера
    sdominanta_agent = SdominantaAgent(private_key=SERVER_AGENT_PRIVATE_KEY)
    print(f"Server Agent Public Key: {sdominanta_agent.public_key}")
    if not SERVER_AGENT_PRIVATE_KEY:
        print(f"!!! SAVE THIS SERVER PRIVATE KEY: {sdominanta_agent.private_key.hex()} !!!")
    
    # Добавляем публичный ключ самого агента сервера в список известных пиров
    known_peers.add(sdominanta_agent.public_key)

    # Запускаем подключение и прослушивание в фоновом режиме
    @app.on_event("startup")
    async def startup_event():
        if sdominanta_agent:
            await sdominanta_agent.connect(ws_url=daemon_url)
            # Подписываемся на публичные сообщения
            await sdominanta_agent.subscribe("sub_general", {"kinds": [EventKind.TEXT_NOTE]})
            # Подписываемся на личные сообщения, адресованные этому агенту
            await sdominanta_agent.subscribe("sub_dm", {"kinds": [EventKind.ENCRYPTED_DIRECT_MESSAGE], "#p": [sdominanta_agent.public_key]})
            asyncio.create_task(sdominanta_agent.listen(handle_p2p_message))

    @app.on_event("shutdown")
    async def shutdown_event():
        if sdominanta_agent:
            await sdominanta_agent.close()


@app.post("/api/v1/wall/publish")
async def wall_publish(note_signed: Dict): # note_signed теперь это событие Nostr в словаре
    """Публикует подписанную заметку на стену через P2P-сеть."""
    if not sdominanta_agent:
        raise HTTPException(status_code=503, detail="P2P service not enabled or connected.")
    
    # Определяем thread_id из tags, если есть, иначе используем 'general'
    thread_id = "general"
    for tag in note_signed.get('tags', []):
        if tag[0] == 't':
            thread_id = tag[1]
            break

    # Используем WallAPI для публикации заметки
    return await wall_api.publish_note(
        author_id=sdominanta_agent.public_key, # Публичный ключ агента сервера как автор
        thread_id=thread_id,
        content=note_signed, # Вся подписанная заметка как контент
        is_private=False, # Пока не реализована приватность
        recipient_user_id=None
    )

# @app.post("/api/v1/gemma/ask") # Этот эндпоинт теперь не нужен, так как Gemma обрабатывается внутри агента
# async def gemma_ask(request: GemmaRequest):
#     """Отправляет запрос к Gemma и возвращает ее ответ."""
#     ollama_url = "http://ollama:11434/api/generate"
#     payload = {
#         "model": "gemma:2b", # Используем модель gemma:2b для более быстрых ответов
#         "prompt": request.prompt,
#         "stream": False  # Получаем ответ целиком, а не по частям
#     }

#     try:
#         async with httpx.AsyncClient(timeout=120.0) as client: # Увеличим таймаут для долгих ответов
#             response = await client.post(ollama_url, json=payload)
#             response.raise_for_status() # Вызовет исключение для HTTP-ошибок
            
#             # Извлекаем и возвращаем только сам текстовый ответ
#             response_data = response.json()
#             return JSONResponse(status_code=200, content={"response": response_data.get("response", "")})

#     except httpx.RequestError as e:
#         raise HTTPException(status_code=503, detail=f"Service unavailable: Could not connect to Ollama server. {e}")
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {e}")


@app.get("/api/v1/wall/threads")
async def wall_threads(thread_id: str = "general", since: str = None, limit: int = 50):
    """Получает заметки из указанного треда стены."""
    return await wall_api.get_thread_notes(thread_id=thread_id, since=since, limit=limit)

@app.get("/api/v1/peers")
async def peers_list():
    """Получает список известных пиров в P2P-сети."""
    if not sdominanta_agent:
        raise HTTPException(status_code=503, detail="P2P service not enabled or connected.")
    
    # Возвращаем список известных пиров
    return JSONResponse(status_code=200, content=list(known_peers))


@app.get("/api/v1/fs/list/{directory_path:path}")
async def list_files(directory_path: str):
    """
    Предоставляет листинг файлов и папок по указанному пути внутри контейнера.
    Путь указывается относительно корня проекта (/app).
    Пример: /api/v1/fs/list/mcp/agents
    """
    # Импортируем Path внутри, чтобы не добавлять в глобальные импорты
    from pathlib import Path

    # Базовый путь:
    # - если определен APP_BASE_PATH, используем его
    # - иначе, если существует "/app" (контейнер), используем его
    # - иначе используем текущую рабочую директорию
    env_base_path = os.getenv("APP_BASE_PATH")
    if env_base_path:
        base_path = Path(env_base_path).resolve()
    else:
        container_base = Path("/app")
        base_path = container_base.resolve() if container_base.exists() else Path.cwd().resolve()
    
    # Создаем полный путь и разрешаем его (убираем .. и т.д.)
    target_path = (base_path / directory_path).resolve()

    # Проверка безопасности: убеждаемся, что целевой путь находится внутри базового.
    if base_path not in target_path.parents and target_path != base_path:
        raise HTTPException(
            status_code=403,
            detail="Access denied: Path is outside the allowed project directory."
        )

    if not target_path.exists():
        raise HTTPException(status_code=404, detail="Path not found")

    if not target_path.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    try:
        contents = []
        for item in sorted(target_path.iterdir()):
            item_type = "directory" if item.is_dir() else "file"
            contents.append({"name": item.name, "type": item_type})
        
        return JSONResponse(status_code=200, content={
            "directory": str(target_path.relative_to(base_path)),
            "contents": contents
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read directory: {e}")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket-эндпоинт для подписки на события P2P-сети."""
    await websocket.accept()
    print(f"WebSocket connection established: {websocket.client}")
    connected_websockets.add(websocket) # Добавляем WebSocket в набор

    # Подписка на топики P2P и отправка событий клиенту
    try:
        while True:
            data = await websocket.receive_text() # Ждем входящих сообщений (если есть)
            # print(f"Received from WS client: {data}")
            # Отправляем что-то обратно, имитируя события
            # await websocket.send_json({"event": "heartbeat", "timestamp": datetime.utcnow().isoformat()})
            await asyncio.sleep(1) # Небольшая задержка
    except Exception as e:
        print(f"WebSocket disconnected: {websocket.client} with error: {e}")
    finally:
        connected_websockets.remove(websocket) # Удаляем WebSocket из набора при разрыве соединения
