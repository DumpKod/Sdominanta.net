import pytest
import asyncio
import json
import httpx
from unittest.mock import Mock, patch, AsyncMock
from fastapi.testclient import TestClient
from bridge.main import app
from pathlib import Path
from fastapi import WebSocket

# Тестовые данные
TEST_NOTE = {
    "id": "test_note_id_123",
    "pubkey": "test_pubkey_456",
    "created_at": 1640995200,
    "kind": 1,
    "tags": [["t", "general"], ["e", "parent_event_id"]],
    "content": "Тестовая заметка для проверки API",
    "sig": "test_signature_789"
}

TEST_THREAD_ID = "test_thread"
TEST_PEER_ID = "test_peer_123"

class TestBridgeAPI:
    """Тесты для API Bridge"""
    
    @pytest.fixture
    def client(self):
        """Создает тестовый клиент FastAPI"""
        return TestClient(app)
    
    @pytest.fixture
    def mock_wall_api(self):
        """Мокает WallAPI для тестирования"""
        with patch('bridge.main.wall_api') as mock:
            mock.get_thread_notes = AsyncMock(return_value=[TEST_NOTE])
            mock.publish_note = AsyncMock(return_value={
                "status": "note_published",
                "note_id": TEST_NOTE["id"],
                "git_status": "success"
            })
            yield mock
    
    @pytest.fixture
    def mock_sdominanta_agent(self):
        """Мокает SdominantaAgent для тестирования"""
        with patch('bridge.main.sdominanta_agent') as mock:
            mock.public_key = TEST_PEER_ID
            mock.private_key = Mock()
            mock.private_key.hex.return_value = "test_private_key_hex"
            yield mock

    def test_wall_threads_endpoint(self, client, mock_wall_api):
        """Тест эндпоинта GET /api/v1/wall/threads"""
        response = client.get(f"/api/v1/wall/threads?thread_id={TEST_THREAD_ID}")
        
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["id"] == TEST_NOTE["id"]

    def test_wall_publish_endpoint(self, client, mock_wall_api, mock_sdominanta_agent):
        """Тест эндпоинта POST /api/v1/wall/publish"""
        response = client.post("/api/v1/wall/publish", json=TEST_NOTE)
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "note_published"
        assert data["note_id"] == TEST_NOTE["id"]
        assert data["git_status"] == "success"

    def test_peers_list_endpoint(self, client, mock_sdominanta_agent):
        """Тест эндпоинта GET /api/v1/peers"""
        with patch('bridge.main.known_peers', {TEST_PEER_ID, "another_peer_456"}):
            response = client.get("/api/v1/peers")
            
            assert response.status_code == 200
            data = response.json()
            assert isinstance(data, list)
            assert TEST_PEER_ID in data
            assert len(data) == 2

    def test_peers_list_no_agent(self, client):
        """Тест эндпоинта GET /api/v1/peers когда агент недоступен"""
        with patch('bridge.main.sdominanta_agent', None):
            response = client.get("/api/v1/peers")
            
            assert response.status_code == 503
            data = response.json()
            assert "detail" in data
            assert "P2P service not enabled" in data["detail"]

    @pytest.mark.asyncio
    async def test_websocket_connection(self):
        """Тест WebSocket соединения"""
        client = TestClient(app)
        
        with client.websocket_connect("/ws") as websocket:
            assert websocket is not None
            # Отправляем тестовое сообщение, но не ожидаем ответа в этом тесте
            websocket.send_text(json.dumps({"type": "test", "data": "test_message"}))
            # Просто убедимся, что соединение установлено и отправка прошла без ошибок
            # Сервер может не отправить моментальный ответ в этом сценарии
            # без запущенного P2P агента.
            pass

    def test_fs_list_endpoint(self, client, tmp_path):
        """Тест эндпоинта GET /api/v1/fs/list/{directory_path} с реальной временной директорией"""
        import os
        from pathlib import Path

        base_dir: Path = tmp_path / "app_root"
        agents_dir: Path = base_dir / "mcp" / "agents"
        agents_dir.mkdir(parents=True, exist_ok=True)

        # Создаем файлы и поддиректорию
        (agents_dir / "agent1.py").write_text("print('a1')", encoding="utf-8")
        (agents_dir / "agent2.py").write_text("print('a2')", encoding="utf-8")
        (agents_dir / "subdir").mkdir(exist_ok=True)

        # Устанавливаем базовый путь для эндпоинта через переменную окружения
        os.environ["APP_BASE_PATH"] = str(base_dir)

        try:
            response = client.get("/api/v1/fs/list/mcp/agents")
            assert response.status_code == 200
            data = response.json()
            assert data["directory"] in ("mcp/agents", "mcp\\agents")
            names = {item["name"] for item in data["contents"]}
            types = {item["name"]: item["type"] for item in data["contents"]}
            assert {"agent1.py", "agent2.py", "subdir"}.issubset(names)
            assert types["agent1.py"] == "file"
            assert types["agent2.py"] == "file"
            assert types["subdir"] == "directory"
        finally:
            # Чистим переменную окружения, чтобы не повлиять на другие тесты
            os.environ.pop("APP_BASE_PATH", None)

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
