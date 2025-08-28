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
from bridge.error_handler import safe_websocket_send, log_error_with_context, safe_p2p_operation
from bridge.cache_manager import (
    api_cache, wall_cache, task_manager, performance_monitor,
    cached_async, initialize_performance_system, shutdown_performance_system
)
from bridge.logger import (
    log_manager, log_api_request, log_p2p_event, log_performance_metric,
    log_error, setup_fastapi_logging
)
import json
import logging
import time

app = FastAPI()

# Инициализация WallAPI
wall_api = WallAPI()

connected_websockets: set[WebSocket] = set() # Глобальный набор для хранения активных WebSocket-соединений

async def handle_p2p_message(msg: str):
    """Обработка входящих P2P сообщений с улучшенной обработкой ошибок"""
    global known_peers
    global connected_websockets

    logging.info(f"[SERVER AGENT RECEIVED]: {msg}")

    try:
        data = json.loads(msg)
        if data[0] == "EVENT":
            event_data = data[2]
            event_pubkey = event_data.get("pubkey")

            if event_pubkey and event_pubkey not in known_peers:
                known_peers.add(event_pubkey)
                log_p2p_event("peer_added", peer=event_pubkey, event_data={"old_count": len(known_peers) - 1})

            # Отправляем P2P событие всем подключенным WebSocket-клиентам с безопасной обработкой
            disconnected_websockets = []
            for websocket in connected_websockets.copy():
                success = await safe_websocket_send(websocket, {"type": "p2p_event", "data": event_data})
                if not success:
                    disconnected_websockets.append(websocket)

            # Удаляем отключенные WebSocket соединения
            for websocket in disconnected_websockets:
                if websocket in connected_websockets:
                    connected_websockets.remove(websocket)
                    logging.warning("Removed disconnected WebSocket from connected_websockets")

            # Логируем успешную обработку события
            log_p2p_event("event_processed", event_data={"event_type": "message", "recipients": len(connected_websockets)})

    except json.JSONDecodeError as e:
        log_error(e, "P2P message JSON parsing", {"message": msg})
    except Exception as e:
        log_error(e, "P2P message processing", {"message": msg})


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

# Глобальные переменные для P2P
sdominanta_agent: SdominantaAgent = None
p2p_background_task = None
p2p_connection_status = "disconnected"  # disconnected, connecting, connected, error
p2p_connection_error = None

# Приватный ключ агента для сервера. В продакшене использовать Docker Secrets.
SERVER_AGENT_PRIVATE_KEY = os.getenv("SERVER_AGENT_PRIVATE_KEY", None)
known_peers: set[str] = set() # Глобальный набор для хранения известных публичных ключей пиров

async def init_p2p_agent():
    """Инициализация и подключение P2P агента с обработкой ошибок"""
    global sdominanta_agent, p2p_connection_status, p2p_connection_error

    if not CONFIG.get('p2p_enabled', False):
        print("P2P service is disabled in configuration")
        return False

    try:
        p2p_connection_status = "connecting"
        daemon_url = os.getenv("P2P_WS_URL", "ws://127.0.0.1:9090")

        print(f"Initializing P2P agent with daemon URL: {daemon_url}")

        # Инициализируем SdominantaAgent с приватным ключом сервера
        sdominanta_agent = SdominantaAgent(private_key=SERVER_AGENT_PRIVATE_KEY)
        print(f"Server Agent Public Key: {sdominanta_agent.public_key}")

        if not SERVER_AGENT_PRIVATE_KEY:
            print(f"!!! SAVE THIS SERVER PRIVATE KEY: {sdominanta_agent.private_key.hex()} !!!")

        # Добавляем публичный ключ самого агента сервера в список известных пиров
        known_peers.add(sdominanta_agent.public_key)

        # Подключаемся к P2P daemon через безопасную операцию с retry
        await safe_p2p_operation(sdominanta_agent.connect, ws_url=daemon_url)

        # Подписываемся на публичные сообщения
        await sdominanta_agent.subscribe("sub_general", {"kinds": [EventKind.TEXT_NOTE]})
        # Подписываемся на личные сообщения, адресованные этому агенту
        await sdominanta_agent.subscribe("sub_dm", {"kinds": [EventKind.ENCRYPTED_DIRECT_MESSAGE], "#p": [sdominanta_agent.public_key]})

        p2p_connection_status = "connected"
        print("P2P agent successfully initialized and connected")
        return True

    except Exception as e:
        p2p_connection_status = "error"
        p2p_connection_error = str(e)
        print(f"Failed to initialize P2P agent: {e}")
        return False

async def start_p2p_listening():
    """Запуск прослушивания P2P сообщений в фоне"""
    global p2p_background_task

    if sdominanta_agent and p2p_connection_status == "connected":
        try:
            p2p_background_task = asyncio.create_task(sdominanta_agent.listen(handle_p2p_message))
            print("P2P listening task started")
        except Exception as e:
            print(f"Failed to start P2P listening: {e}")
            p2p_connection_status = "error"
            p2p_connection_error = str(e)

async def stop_p2p_agent():
    """Корректное завершение работы P2P агента"""
    global sdominanta_agent, p2p_background_task, p2p_connection_status

    if p2p_background_task and not p2p_background_task.done():
        print("Cancelling P2P background task...")
        p2p_background_task.cancel()
        try:
            await p2p_background_task
        except asyncio.CancelledError:
            print("P2P background task cancelled")

        if sdominanta_agent:
            try:
                print("Closing P2P agent connection...")
                await sdominanta_agent.close()
                print("P2P agent connection closed")
            except Exception as e:
                print(f"Error closing P2P agent: {e}")

    p2p_connection_status = "disconnected"

# Lifespan event handler для FastAPI (замена устаревшего on_event)
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Управление жизненным циклом приложения"""
    # Startup
    setup_fastapi_logging()
    logging.info("🚀 Инициализация системы Sdominanta.net")

    await init_p2p_agent()
    await start_p2p_listening()
    await initialize_performance_system()

    logging.info("✅ Все системы инициализированы успешно")
    yield
    # Shutdown
    logging.info("🔄 Начинаем завершение работы системы")
    await stop_p2p_agent()
    await shutdown_performance_system()
    logging.info("🛑 Система завершена корректно")

# Обновляем app для использования lifespan
app.router.lifespan_context = lifespan


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


@cached_async(wall_cache, ttl=60)
async def _get_wall_notes_cached(thread_id: str = "general", since: str = None, limit: int = 50):
    """Кэшированная версия получения заметок стены"""
    return await wall_api.get_thread_notes(thread_id=thread_id, since=since, limit=limit)

@app.get("/api/v1/wall/threads")
async def wall_threads(thread_id: str = "general", since: str = None, limit: int = 50):
    """Получает заметки из указанного треда стены."""
    start_time = time.time()
    try:
        result = await _get_wall_notes_cached(thread_id=thread_id, since=since, limit=limit)
        response_time = (time.time() - start_time) * 1000  # в миллисекундах

        # Логируем успешный запрос
        log_performance_metric('wall_threads_response_time', response_time, {
            'thread_id': thread_id,
            'cached': True
        })

        performance_monitor.record_metric('wall_threads_response_time', response_time)
        return result
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        log_performance_metric('wall_threads_error_time', response_time, {
            'thread_id': thread_id,
            'error': str(e)
        })
        performance_monitor.record_metric('wall_threads_error_time', response_time)
        log_error(e, "wall_threads_endpoint", {
            'thread_id': thread_id,
            'since': since,
            'limit': limit
        })
        raise

@cached_async(api_cache, ttl=30)
async def _get_peers_cached():
    """Кэшированная версия получения списка пиров"""
    if not sdominanta_agent:
        raise HTTPException(status_code=503, detail="P2P service not enabled or connected.")

    return list(known_peers)

@app.get("/api/v1/peers")
async def peers_list():
    """Получает список известных пиров в P2P-сети."""
    start_time = time.time()
    try:
        peers = await _get_peers_cached()
        response_time = time.time() - start_time
        performance_monitor.record_metric('peers_list_response_time', response_time)
        return JSONResponse(status_code=200, content=peers)
    except HTTPException:
        # Не кэшируем HTTP исключения
        raise
    except Exception as e:
        response_time = time.time() - start_time
        performance_monitor.record_metric('peers_list_error_time', response_time)
        log_error_with_context(e, "peers_list_endpoint")
        raise

@cached_async(api_cache, ttl=10)
async def _get_p2p_status_cached():
    """Кэшированная версия получения P2P статуса"""
    # Безопасная сериализация public_key
    agent_key = None
    if sdominanta_agent and hasattr(sdominanta_agent, 'public_key'):
        agent_key = str(sdominanta_agent.public_key)

    return {
        "enabled": CONFIG.get('p2p_enabled', False),
        "status": p2p_connection_status,
        "error": p2p_connection_error,
        "agent_public_key": agent_key,
        "known_peers_count": len(known_peers),
        "daemon_url": os.getenv("P2P_WS_URL", "ws://127.0.0.1:9090") if CONFIG.get('p2p_enabled', False) else None
    }

@app.get("/api/v1/p2p/status")
async def p2p_status():
    """Получает статус P2P подключения."""
    start_time = time.time()
    try:
        status = await _get_p2p_status_cached()
        response_time = time.time() - start_time
        performance_monitor.record_metric('p2p_status_response_time', response_time)
        return JSONResponse(status_code=200, content=status)
    except Exception as e:
        response_time = time.time() - start_time
        performance_monitor.record_metric('p2p_status_error_time', response_time)
        log_error_with_context(e, "p2p_status_endpoint")
        raise


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
        
        result = {
            "directory": str(target_path.relative_to(base_path)),
            "contents": contents
        }

        # Добавляем кэширование для часто запрашиваемых директорий
        if len(contents) <= 50:  # Кэшируем только небольшие директории
            cache_key = f"fs_list_{directory_path}"
            api_cache.put(cache_key, result, ttl=60)  # Кэш на 1 минуту

        return JSONResponse(status_code=200, content=result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read directory: {e}")

@app.get("/api/v1/performance/stats")
async def performance_stats():
    """Получает статистику производительности системы"""
    try:
        cache_stats = {
            'api_cache': api_cache.stats(),
            'wall_cache': wall_cache.stats()
        }

        performance_stats = performance_monitor.get_stats()
        active_tasks = await task_manager.get_active_tasks()

        return JSONResponse(status_code=200, content={
            'cache_stats': cache_stats,
            'performance_stats': performance_stats,
            'active_tasks_count': len(active_tasks),
            'system_health': {
                'cache_hit_rate': cache_stats['api_cache'].get('hit_rate', 0),
                'average_response_time': performance_monitor.get_average('wall_threads_response_time', 10),
                'error_count': len([k for k in performance_stats.keys() if 'error' in k])
            }
        })
    except Exception as e:
        log_error_with_context(e, "performance_stats_endpoint")
        raise HTTPException(status_code=500, detail=f"Failed to get performance stats: {e}")

@app.post("/api/v1/cache/clear")
async def clear_cache():
    """Очищает кэш системы"""
    try:
        api_cache.clear()
        wall_cache.clear()
        return JSONResponse(status_code=200, content={
            "message": "Cache cleared successfully",
            "cleared_caches": ["api_cache", "wall_cache"]
        })
    except Exception as e:
        log_error_with_context(e, "clear_cache_endpoint")
        raise HTTPException(status_code=500, detail=f"Failed to clear cache: {e}")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket-эндпоинт для подписки на события P2P-сети."""
    await websocket.accept()
    print(f"WebSocket connection established: {websocket.client}")
    connected_websockets.add(websocket) # Добавляем WebSocket в набор

    # Подписка на топики P2P и отправка событий клиенту
    try:
        while True:
            try:
                # Ждем входящих сообщений с таймаутом 10 секунд
                data = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
                print(f"Received from WS client: {data}")

                # Обрабатываем входящее сообщение
                try:
                    message = json.loads(data)
                    message_type = message.get("type")

                    if message_type == "ping":
                        # Отвечаем на ping
                        await websocket.send_json({
                            "type": "pong",
                            "timestamp": asyncio.get_event_loop().time()
                        })
                    elif message_type == "test":
                        # Отвечаем на тестовое сообщение
                        await websocket.send_json({
                            "type": "p2p_event",
                            "data": message.get("data", ""),
                            "received": True
                        })
                    else:
                        # Неизвестный тип сообщения
                        await websocket.send_json({
                            "type": "error",
                            "message": f"Unknown message type: {message_type}"
                        })

                except json.JSONDecodeError:
                    # Сообщение не является корректным JSON
                    await websocket.send_json({
                        "type": "error",
                        "message": "Invalid JSON format"
                    })
                except Exception as e:
                    print(f"Error processing message: {e}")
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Processing error: {str(e)}"
                    })

            except asyncio.TimeoutError:
                # Таймаут - отправляем heartbeat если нужно
                pass
            except Exception as e:
                # Проверяем, является ли это нормальным закрытием соединения
                if isinstance(e, (ConnectionError, OSError)) or (hasattr(e, 'code') and e.code == 1000):
                    print(f"WebSocket connection closed normally: {e}")
                    break
                else:
                    print(f"Error receiving message: {e}")
                    break

    except Exception as e:
        print(f"WebSocket disconnected: {websocket.client} with error: {e}")
    finally:
        if websocket in connected_websockets:
            connected_websockets.remove(websocket)  # Удаляем WebSocket из набора при разрыве соединения
