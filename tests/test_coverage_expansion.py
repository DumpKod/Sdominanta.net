#!/usr/bin/env python3
"""
Расширенные тесты для увеличения покрытия кода
"""

import pytest
import asyncio
import json
import os
from unittest.mock import Mock, patch, AsyncMock, MagicMock
from fastapi.testclient import TestClient
from bridge.main import app
from bridge.error_handler import CircuitBreaker, AsyncRetry, safe_websocket_send


class TestCoverageExpansion:
    """Тесты для расширения покрытия кода"""

    @pytest.fixture
    def client(self):
        """Создает тестовый клиент FastAPI"""
        return TestClient(app)

    def test_config_file_handling(self, client):
        """Тест обработки конфигурационного файла"""
        # Тест с существующим конфигом
        with patch('os.path.exists', return_value=True), \
             patch('builtins.open', create=True) as mock_open, \
             patch('yaml.safe_load', return_value={'p2p_enabled': True}):

            mock_open.return_value.__enter__.return_value.read.return_value = "p2p_enabled: true"

            # Импортируем заново для применения конфига
            import importlib
            import bridge.main
            importlib.reload(bridge.main)

            # Проверяем, что конфиг загружен
            from bridge.main import CONFIG
            assert CONFIG.get('p2p_enabled') == True

    def test_config_file_missing(self, client):
        """Тест обработки отсутствующего конфигурационного файла"""
        with patch('os.path.exists', return_value=False), \
             patch('builtins.open', side_effect=FileNotFoundError):

            # Импортируем заново
            import importlib
            import bridge.main
            importlib.reload(bridge.main)

            # Проверяем, что используется конфиг по умолчанию
            from bridge.main import CONFIG
            assert CONFIG.get('p2p_enabled', False) == False

    def test_environment_variables(self, client):
        """Тест обработки переменных окружения"""
        with patch.dict(os.environ, {
            'SERVER_AGENT_PRIVATE_KEY': 'test_key_hex',
            'P2P_WS_URL': 'ws://custom-host:9090',
            'BRIDGE_CONFIG_PATH': '/custom/path/config.yaml'
        }):
            # Проверяем, что переменные окружения используются
            from bridge.main import SERVER_AGENT_PRIVATE_KEY
            assert SERVER_AGENT_PRIVATE_KEY == 'test_key_hex'

    def test_wall_api_error_handling(self, client):
        """Тест обработки ошибок в Wall API"""
        from bridge.api.wall import WallAPI

        wall_api = WallAPI()

        # Тест с несуществующей директорией
        with patch('os.path.exists', return_value=False):
            result = asyncio.run(wall_api.get_thread_notes('nonexistent'))
            assert result == []  # Должен вернуть пустой список

        # Тест с поврежденным JSON файлом
        with patch('os.path.exists', return_value=True), \
             patch('os.listdir', return_value=['test.json']), \
             patch('builtins.open', create=True) as mock_open:

            mock_file = MagicMock()
            mock_file.__enter__.return_value.read.return_value = "invalid json"
            mock_open.return_value = mock_file

            result = asyncio.run(wall_api.get_thread_notes('general'))
            assert result == []  # Должен обработать ошибку JSON

    def test_websocket_error_recovery(self, client):
        """Тест восстановления после WebSocket ошибок"""
        with client.websocket_connect("/ws") as websocket:
            # Тест множественных корректных сообщений
            for i in range(5):
                websocket.send_text(json.dumps({"type": "test", "data": f"recovery_test_{i}"}))
                response = websocket.receive_json()
                assert response["type"] == "p2p_event"
                assert response["received"] == True

            # Тест восстановления после ошибок
            websocket.send_text("invalid json")
            error_response = websocket.receive_json()
            assert error_response["type"] == "error"

            # Проверяем, что соединение все еще работает
            websocket.send_text(json.dumps({"type": "test", "data": "after_error"}))
            response = websocket.receive_json()
            assert response["type"] == "p2p_event"

    def test_circuit_breaker_states(self):
        """Тест всех состояний Circuit Breaker"""
        from bridge.error_handler import CircuitBreakerConfig
        config = CircuitBreakerConfig(
            failure_threshold=3,
            recovery_timeout=1.0,
            expected_exception=(ValueError, ConnectionError)
        )
        cb = CircuitBreaker(config)

        # Тест CLOSED состояния
        assert cb.state.value == "closed"
        assert cb.failure_count == 0

        # Тест перехода в OPEN состояние
        call_count = 0

        async def failing_func():
            nonlocal call_count
            call_count += 1
            raise ConnectionError(f"Fail {call_count}")

        # Вызываем функцию несколько раз до перехода в OPEN
        for i in range(4):
            try:
                asyncio.run(cb.call(failing_func))
            except ConnectionError:
                pass

        assert cb.state.value == "open"
        assert cb.failure_count >= 3

        # Тест HALF_OPEN состояния
        import time
        time.sleep(1.1)  # Ждем recovery_timeout

        async def success_func():
            return "success"

        # Следующий вызов должен перейти в HALF_OPEN
        result = asyncio.run(cb.call(success_func))
        assert result == "success"
        assert cb.state.value == "closed"  # После успешного вызова

    def test_async_retry_edge_cases(self):
        """Тест граничных случаев AsyncRetry"""
        from bridge.error_handler import RetryConfig
        config = RetryConfig(
            max_attempts=3,
            base_delay=0.1,
            exponential_backoff=True,
            jitter=False
        )
        retry = AsyncRetry(config)

        # Тест с нулевым количеством попыток
        config_zero = RetryConfig(
            max_attempts=0,
            base_delay=0.1,
            exponential_backoff=True,
            jitter=False
        )
        retry_zero = AsyncRetry(config_zero)

        async def success_func():
            return "success"

        # Должен выполниться без повторных попыток
        result = asyncio.run(retry_zero.execute(success_func))
        assert result == "success"

        # Тест с очень большой задержкой
        config_big_delay = config.copy()
        config_big_delay['max_delay'] = 0.001  # Маленькая максимальная задержка
        retry_big = AsyncRetry(config_big_delay)

        call_count = 0
        async def slow_fail():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise ValueError("Temporary error")
            return "success"

        start_time = asyncio.get_event_loop().time()
        result = asyncio.run(retry_big.execute(slow_fail))
        end_time = asyncio.get_event_loop().time()

        assert result == "success"
        assert call_count == 2
        # Задержка должна быть ограничена max_delay
        assert (end_time - start_time) < 1.0

    def test_safe_websocket_send_edge_cases(self):
        """Тест граничных случаев safe_websocket_send"""

        # Тест с None websocket
        result = asyncio.run(safe_websocket_send(None, {"test": "data"}))
        assert result == False

        # Тест с неполным websocket объектом
        mock_ws = Mock()
        del mock_ws.send_json  # Удаляем метод

        result = asyncio.run(safe_websocket_send(mock_ws, {"test": "data"}))
        assert result == False

        # Тест с успешной отправкой
        mock_ws_success = Mock()
        mock_ws_success.send_json = AsyncMock(return_value=None)

        result = asyncio.run(safe_websocket_send(mock_ws_success, {"test": "data"}))
        assert result == True
        mock_ws_success.send_json.assert_called_once_with({"test": "data"})

    def test_p2p_message_edge_cases(self):
        """Тест граничных случаев обработки P2P сообщений"""
        from bridge.main import handle_p2p_message

        # Тест с пустым сообщением
        asyncio.run(handle_p2p_message(""))

        # Тест с неправильным форматом массива
        asyncio.run(handle_p2p_message('{"not": "array"}'))

        # Тест с EVENT без данных
        asyncio.run(handle_p2p_message('["EVENT"]'))

        # Тест с EVENT и данными, но без pubkey
        asyncio.run(handle_p2p_message('["EVENT", "sub", {"content": "test"}]'))

        # Тест с некорректным JSON в середине
        asyncio.run(handle_p2p_message('["EVENT", "sub", {invalid json}]'))

        print("Все граничные случаи обработки P2P сообщений пройдены!")

    def test_concurrent_websocket_operations(self, client):
        """Тест одновременных операций с WebSocket"""
        import threading

        results = []
        errors = []

        def websocket_operation(operation_id: int):
            """Индивидуальная операция WebSocket"""
            try:
                with client.websocket_connect("/ws") as websocket:
                    # Выполняем несколько операций
                    for i in range(3):
                        websocket.send_text(json.dumps({
                            "type": "test",
                            "data": f"op_{operation_id}_msg_{i}"
                        }))

                        response = websocket.receive_json()
                        results.append((operation_id, i, response))

                    results.append((operation_id, "completed", None))

            except Exception as e:
                errors.append((operation_id, str(e)))

        # Запускаем 5 одновременных операций
        threads = []
        for i in range(5):
            thread = threading.Thread(target=websocket_operation, args=(i,))
            threads.append(thread)
            thread.start()

        # Ждем завершения
        for thread in threads:
            thread.join(timeout=15)

        # Анализируем результаты
        completed_operations = [r for r in results if r[1] == "completed"]
        total_messages = len([r for r in results if isinstance(r[1], int)])

        print(f"Завершенных операций: {len(completed_operations)}")
        print(f"Всего сообщений: {total_messages}")
        print(f"Ошибок: {len(errors)}")

        # Проверяем, что большинство операций завершилось успешно
        assert len(completed_operations) >= 3
        assert total_messages >= 10  # Минимум 10 сообщений
        assert len(errors) <= 2  # Максимум 2 ошибки

    def test_memory_leaks_prevention(self, client):
        """Тест предотвращения утечек памяти"""
        import gc
        import psutil
        import os

        process = psutil.Process(os.getpid())

        # Получаем начальные метрики
        initial_memory = process.memory_info().rss
        initial_objects = len(gc.get_objects())

        # Выполняем множество операций
        for i in range(50):
            # API вызовы
            client.get('/api/v1/p2p/status')
            client.get('/api/v1/wall/threads?thread_id=general')

            # WebSocket операции
            with client.websocket_connect("/ws") as websocket:
                websocket.send_text(json.dumps({"type": "test", "data": f"memory_test_{i}"}))
                response = websocket.receive_json()

        # Принудительная сборка мусора
        gc.collect()

        # Получаем финальные метрики
        final_memory = process.memory_info().rss
        final_objects = len(gc.get_objects())

        memory_increase = final_memory - initial_memory
        object_increase = final_objects - initial_objects

        print(f"Увеличение памяти: {memory_increase / 1024:.1f} KB")
        print(f"Увеличение объектов: {object_increase}")

        # Проверяем, что нет значительных утечек
        assert memory_increase < 10 * 1024 * 1024, "Слишком большое увеличение памяти (10MB+)"
        assert object_increase < 1000, "Слишком большое увеличение количества объектов"

    def test_logging_coverage(self, client):
        """Тест покрытия логирования"""
        import logging
        from io import StringIO

        # Настраиваем логирование в память
        log_stream = StringIO()
        handler = logging.StreamHandler(log_stream)
        logger = logging.getLogger('bridge.main')
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)

        try:
            # Выполняем операции, которые должны логироваться
            client.get('/api/v1/p2p/status')

            with client.websocket_connect("/ws") as websocket:
                websocket.send_text(json.dumps({"type": "test", "data": "logging_test"}))
                websocket.receive_json()

            # Проверяем логи
            log_contents = log_stream.getvalue()
            assert len(log_contents) > 0, "Логи не записались"

            # Проверяем наличие ключевых сообщений
            assert "WebSocket connection established" in log_contents

        finally:
            logger.removeHandler(handler)

    def test_exception_chaining(self, client):
        """Тест цепочки исключений"""
        from bridge.error_handler import log_error_with_context

        # Тест логирования ошибки с контекстом
        try:
            raise ValueError("Test error")
        except ValueError as e:
            log_error_with_context(e, "test_context", {"extra": "data"})

        # Тест вложенных исключений
        try:
            try:
                raise ConnectionError("Inner error")
            except ConnectionError:
                raise ValueError("Outer error") from None
        except ValueError as e:
            log_error_with_context(e, "nested_exception_test")

        print("Тест цепочки исключений завершен успешно!")
