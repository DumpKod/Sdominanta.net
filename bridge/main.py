from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Dict
import yaml
import os
from pa2ap.python_adapter.sdominanta_agent.client import SdominantaAgent
import asyncio
import httpx
from pydantic import BaseModel

app = FastAPI()

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
if CONFIG.get('p2p_enabled', False):
    daemon_url = os.getenv("P2P_WS_URL", "ws://127.0.0.1:9090")
    sdominanta_agent = SdominantaAgent(daemon_url=daemon_url)
    # Запускаем подключение в фоновом режиме
    @app.on_event("startup")
    async def startup_event():
        if sdominanta_agent:
            await sdominanta_agent.connect()

    @app.on_event("shutdown")
    async def shutdown_event():
        if sdominanta_agent:
            await sdominanta_agent.disconnect()


@app.post("/api/v1/wall/publish")
async def wall_publish(note_signed: Dict):
    """Публикует подписанную заметку на стену через P2P-сеть."""
    if not sdominanta_agent:
        raise HTTPException(status_code=503, detail="P2P service not enabled or connected.")
    
    # TODO: Добавить валидацию подписи заметки перед публикацией
    # from scripts.verify_wall_signatures import verify_signature # Нужен импорт и реализация
    # if not verify_signature(note_signed):
    #     raise HTTPException(status_code=400, detail="Invalid signature.")

    await sdominanta_agent.publish("sdom/wall", note_signed)
    return JSONResponse(status_code=202, content={"message": "Note published to P2P wall."})

@app.post("/api/v1/gemma/ask")
async def gemma_ask(request: GemmaRequest):
    """Отправляет запрос к Gemma и возвращает ее ответ."""
    ollama_url = "http://ollama:11434/api/generate"
    payload = {
        "model": "gemma:2b", # Используем модель gemma:2b для более быстрых ответов
        "prompt": request.prompt,
        "stream": False  # Получаем ответ целиком, а не по частям
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as client: # Увеличим таймаут для долгих ответов
            response = await client.post(ollama_url, json=payload)
            response.raise_for_status() # Вызовет исключение для HTTP-ошибок
            
            # Извлекаем и возвращаем только сам текстовый ответ
            response_data = response.json()
            return JSONResponse(status_code=200, content={"response": response_data.get("response", "")})

    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"Service unavailable: Could not connect to Ollama server. {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {e}")


@app.get("/api/v1/wall/threads")
async def wall_threads(thread_id: str = "general", since: str = None, limit: int = 50):
    """Получает заметки из указанного треда стены."""
    # TODO: Реализовать чтение из локальных wall/threads/*.json файлов
    # Это потребует отдельного модуля для работы с Git-репозиторием и чтением файлов.
    # Для MVP просто заглушка:
    return JSONResponse(status_code=200, content=[])

@app.get("/api/v1/peers")
async def peers_list():
    """Получает список известных пиров в P2P-сети."""
    if not sdominanta_agent:
        raise HTTPException(status_code=503, detail="P2P service not enabled or connected.")
    
    # TODO: Реализовать получение реального списка пиров от SdominantaAgent
    # Пока SdominantaAgent только анонсирует, но не возвращает список через API. 
    # Нужна доработка SdominantaAgent и/или логика в bridge для получения актуального списка.
    return JSONResponse(status_code=200, content=[sdominanta_agent.peer_id if sdominanta_agent else "unknown"])


@app.get("/api/v1/fs/list/{directory_path:path}")
async def list_files(directory_path: str):
    """
    Предоставляет листинг файлов и папок по указанному пути внутри контейнера.
    Путь указывается относительно корня проекта (/app).
    Пример: /api/v1/fs/list/mcp/agents
    """
    # Импортируем Path внутри, чтобы не добавлять в глобальные импорты
    from pathlib import Path

    # Базовый путь внутри контейнера, к которому разрешен доступ.
    base_path = Path("/app").resolve()
    
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

    # TODO: Реализовать подписку на топики P2P и отправку событий клиенту
    # Для MVP просто держим соединение открытым
    try:
        while True:
            data = await websocket.receive_text() # Ждем входящих сообщений (если есть)
            # print(f"Received from WS client: {data}")
            # Отправляем что-то обратно, имитируя события
            # await websocket.send_json({"event": "heartbeat", "timestamp": datetime.utcnow().isoformat()})
            await asyncio.sleep(1) # Небольшая задержка
    except Exception as e:
        print(f"WebSocket disconnected: {websocket.client} with error: {e}")
