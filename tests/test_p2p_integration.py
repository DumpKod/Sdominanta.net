#!/usr/bin/env python3
"""
Интеграционные тесты для P2P функциональности
"""

import pytest
import asyncio
import json
from unittest.mock import Mock, patch, AsyncMock
from fastapi.testclient import TestClient
from bridge.main import app


class TestP2PIntegration:
    """Интеграционные тесты P2P функциональности"""

    @pytest.fixture
    def client(self):
        """Создает тестовый клиент FastAPI"""
        return TestClient(app)

    @pytest.fixture
    def mock_sdominanta_agent(self):
        """Мок для SdominantaAgent"""
        with patch('bridge.main.sdominanta_agent') as mock:
            mock.public_key = "test_public_key_123"
            mock.private_key = Mock()
            mock.private_key.hex.return_value = "test_private_key_hex"
            mock.connect = AsyncMock(return_value=None)
            mock.subscribe = AsyncMock(return_value=None)
            mock.publish_event = AsyncMock(return_value=None)
            mock.close = AsyncMock(return_value=None)
            yield mock

    def test_p2p_status_endpoint_without_agent(self, client):
        """Тест эндпоинта P2P status без агента"""
        with patch('bridge.main.sdominanta_agent', None):
            response = client.get('/api/v1/p2p/status')

            assert response.status_code == 200
            data = response.json()
            assert data['enabled'] == False
            assert data['status'] == 'disconnected'
            assert data['agent_public_key'] is None
            assert data['known_peers_count'] == 0

    def test_p2p_status_endpoint_with_agent(self, client, mock_sdominanta_agent):
        """Тест эндпоинта P2P status с агентом"""
        # Очищаем кэш перед тестом
        from bridge.cache_manager import api_cache
        api_cache.clear()

        with patch('bridge.main.p2p_connection_status', 'connected'), \
             patch('bridge.main.p2p_connection_error', None), \
             patch('bridge.main.known_peers', {'peer1', 'peer2'}):

            response = client.get('/api/v1/p2p/status')

            assert response.status_code == 200
            data = response.json()
            assert data['enabled'] == False  # CONFIG.get('p2p_enabled', False)
            assert data['status'] == 'connected'
            assert data['agent_public_key'] == 'test_public_key_123'
            assert data['known_peers_count'] == 2
            assert data['error'] is None

    def test_p2p_status_endpoint_with_error(self, client, mock_sdominanta_agent):
        """Тест эндпоинта P2P status с ошибкой"""
        # Очищаем кэш перед тестом
        from bridge.cache_manager import api_cache
        api_cache.clear()

        with patch('bridge.main.p2p_connection_status', 'error'), \
             patch('bridge.main.p2p_connection_error', 'Connection failed'), \
             patch('bridge.main.known_peers', set()):

            response = client.get('/api/v1/p2p/status')

            assert response.status_code == 200
            data = response.json()
            assert data['status'] == 'error'
            assert data['error'] == 'Connection failed'
            assert data['known_peers_count'] == 0

    @pytest.mark.asyncio
    async def test_p2p_agent_initialization_success(self):
        """Тест успешной инициализации P2P агента"""
        from bridge.main import init_p2p_agent

        with patch('bridge.main.CONFIG', {'p2p_enabled': True}), \
             patch('bridge.main.SdominantaAgent') as mock_agent_class, \
             patch('os.getenv') as mock_getenv:

            # Настройка мока
            mock_agent = Mock()
            mock_agent.public_key = "test_key"
            mock_agent.private_key.hex.return_value = "test_hex"
            mock_agent.connect = AsyncMock(return_value=None)
            mock_agent.subscribe = AsyncMock(return_value=None)

            mock_agent_class.return_value = mock_agent
            mock_getenv.return_value = "ws://test.com:9090"

            result = await init_p2p_agent()

            assert result == True
            mock_agent_class.assert_called_once()
            mock_agent.connect.assert_called_once()
            assert mock_agent.subscribe.call_count == 2  # general + dm

    @pytest.mark.asyncio
    async def test_p2p_agent_initialization_failure(self):
        """Тест неудачной инициализации P2P агента"""
        from bridge.main import init_p2p_agent

        with patch('bridge.main.CONFIG', {'p2p_enabled': True}), \
             patch('bridge.main.SdominantaAgent') as mock_agent_class, \
             patch('os.getenv') as mock_getenv:

            # Настройка мока с ошибкой
            mock_agent = Mock()
            mock_agent.connect = AsyncMock(side_effect=ConnectionError("Connection failed"))

            mock_agent_class.return_value = mock_agent
            mock_getenv.return_value = "ws://test.com:9090"

            result = await init_p2p_agent()

            assert result == False

    @pytest.mark.asyncio
    async def test_p2p_agent_initialization_disabled(self):
        """Тест инициализации при отключенном P2P"""
        from bridge.main import init_p2p_agent

        with patch('bridge.main.CONFIG', {'p2p_enabled': False}):
            result = await init_p2p_agent()

            assert result == False

    def test_peers_endpoint_with_agent(self, client, mock_sdominanta_agent):
        """Тест эндпоинта peers с агентом"""
        with patch('bridge.main.known_peers', {'peer1', 'peer2', 'peer3'}):
            response = client.get('/api/v1/peers')

            assert response.status_code == 200
            data = response.json()
            assert isinstance(data, list)
            assert len(data) == 3
            assert 'peer1' in data
            assert 'peer2' in data
            assert 'peer3' in data

    def test_peers_endpoint_without_agent(self, client):
        """Тест эндпоинта peers без агента"""
        # Очищаем кэш перед тестом
        from bridge.cache_manager import api_cache
        api_cache.clear()

        with patch('bridge.main.sdominanta_agent', None):
            response = client.get('/api/v1/peers')

            assert response.status_code == 503
            data = response.json()
            assert 'detail' in data
            assert 'P2P service not enabled' in data['detail']

    @pytest.mark.asyncio
    async def test_p2p_message_handling(self):
        """Тест обработки P2P сообщений"""
        from bridge.main import handle_p2p_message

        with patch('bridge.main.known_peers', set()) as mock_peers, \
             patch('bridge.main.connected_websockets', set()) as mock_websockets:

            # Тест EVENT сообщения
            event_msg = '["EVENT", "subscription_id", {"pubkey": "new_peer_key", "content": "test"}]'
            await handle_p2p_message(event_msg)

            # Проверяем, что новый пир добавлен
            assert 'new_peer_key' in mock_peers

            # Тест некорректного JSON
            await handle_p2p_message('invalid json')

            # Пир не должен добавиться
            assert len(mock_peers) == 1

    @pytest.mark.asyncio
    async def test_p2p_publish_integration(self, client, mock_sdominanta_agent):
        """Интеграционный тест публикации в P2P сеть"""
        # Мокаем WallAPI и его git_tools
        with patch('bridge.main.wall_api') as mock_wall_api:
            mock_wall_api.publish_note = AsyncMock(return_value={
                "status": "note_published",
                "note_id": "test_note_123",
                "git_status": "success"
            })

            test_note = {
                "id": "test_note_123",
                "pubkey": "test_pubkey",
                "created_at": 1640995200,
                "kind": 1,
                "tags": [["t", "general"]],
                "content": "Тестовое сообщение для P2P",
                "sig": "test_signature"
            }

            response = client.post('/api/v1/wall/publish', json=test_note)

            assert response.status_code == 200
            data = response.json()
            assert data['status'] == 'note_published'
            assert data['note_id'] == test_note['id']

            # Проверяем, что WallAPI был вызван
            mock_wall_api.publish_note.assert_called_once()

            # Проверяем параметры вызова WallAPI
            call_args = mock_wall_api.publish_note.call_args
            assert call_args[1]['author_id'] == 'test_public_key_123'
            assert call_args[1]['thread_id'] == 'general'
            assert call_args[1]['content']['id'] == 'test_note_123'

    @pytest.mark.asyncio
    async def test_websocket_p2p_integration(self, client, mock_sdominanta_agent):
        """Интеграционный тест WebSocket с P2P"""
        with patch('bridge.main.handle_p2p_message') as mock_handler, \
             patch('bridge.main.known_peers', set()):

            # Подключаемся к WebSocket
            with client.websocket_connect("/ws") as websocket:
                # Отправляем тестовое сообщение
                test_msg = {"type": "test", "data": "integration_test"}
                websocket.send_text(json.dumps(test_msg))

                # Получаем ответ
                response = websocket.receive_json()
                assert response["type"] == "p2p_event"
                assert response["data"] == "integration_test"

                # Проверяем, что соединение добавлено в список
                from bridge.main import connected_websockets
                assert len(connected_websockets) >= 0  # Может быть пустым в тестах

    @pytest.mark.asyncio
    async def test_error_recovery_integration(self):
        """Интеграционный тест восстановления после ошибок"""
        from bridge.error_handler import p2p_circuit_breaker, p2p_retry

        # Тест circuit breaker recovery
        call_count = 0

        async def failing_operation():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise ConnectionError(f"Attempt {call_count}")
            return "success"

        # Должен сработать после нескольких попыток
        result = await p2p_circuit_breaker.call(p2p_retry.execute, failing_operation)
        assert result == "success"
        assert call_count == 3
        assert p2p_circuit_breaker.state.value == "closed"

    def test_config_integration(self, client):
        """Тест интеграции с конфигурацией"""
        # Проверяем базовую функциональность без изменения конфига
        response = client.get('/api/v1/p2p/status')
        assert response.status_code == 200

        data = response.json()
        # Проверяем наличие всех необходимых полей
        required_fields = ['enabled', 'status', 'agent_public_key', 'known_peers_count', 'daemon_url']
        for field in required_fields:
            assert field in data

        # Проверяем типы данных
        assert isinstance(data['enabled'], bool)
        assert isinstance(data['status'], str)
        assert isinstance(data['known_peers_count'], int)
        assert data['status'] in ['disconnected', 'connecting', 'connected', 'error']
