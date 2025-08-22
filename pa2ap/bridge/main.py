from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse
from typing import List

app = FastAPI()

@app.post("/api/v1/wall/publish")
async def wall_publish(note_signed: dict):
    # TODO: Валидация подписи и публикация через p2p-демон
    return {"hash": note_signed.get("hash", "")}, 201

@app.get("/api/v1/wall/threads")
async def wall_threads(since: str = None, limit: int = 50):
    # TODO: Получение заметок из wall/threads
    return []

@app.get("/api/v1/peers")
async def peers_list():
    # TODO: Получение списка пиров через p2p-демон
    return []
