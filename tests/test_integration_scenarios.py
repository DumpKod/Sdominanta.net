#!/usr/bin/env python3
"""
Интеграционные тесты для различных сценариев использования
"""

import pytest
import asyncio
import json
import time
from unittest.mock import Mock, patch, AsyncMock
from fastapi.testclient import TestClient
from bridge.main import app


class TestIntegrationScenarios:
    """Интеграционные тесты различных сценариев"""

    @pytest.fixture
    def client(self):
        """Создает тестовый клиент FastAPI"""
        return TestClient(app)

    def test_full_api_workflow(self, client):
        """Тест полного рабочего процесса API"""
        # 1. Проверяем статус системы
        response = client.get('/api/v1/p2p/status')
        assert response.status_code == 200

        # 2. Получаем список пиров (даже если P2P отключен)
        response = client.get('/api/v1/peers')
        assert response.status_code in [200, 503]  # 503 если P2P отключен

        # 3. Получаем заметки со стены
        response = client.get('/api/v1/wall/threads?thread_id=general')
        assert response.status_code == 200
        wall_data = response.json()
        assert isinstance(wall_data, list)

        # 4. Проверяем файловую систему
        response = client.get('/api/v1/fs/list/mcp')
        assert response.status_code == 200
        fs_data = response.json()
        assert 'directory' in fs_data
        assert 'contents' in fs_data

    @pytest.mark.asyncio
    async def test_websocket_concurrent_connections(self, client):
        """Тест множественных одновременных WebSocket соединений"""
        import threading
        import queue

        results = queue.Queue()
        errors = queue.Queue()

        def websocket_worker(worker_id):
            """Рабочий поток для тестирования WebSocket"""
            try:
                with client.websocket_connect("/ws") as websocket:
                    # Отправляем уникальное сообщение
                    message = {"type": "test", "data": f"worker_{worker_id}", "timestamp": time.time()}
                    websocket.send_text(json.dumps(message))

                    # Получаем ответ
                    response = websocket.receive_json()
                    results.put((worker_id, response))

            except Exception as e:
                errors.put((worker_id, str(e)))

        # Запускаем 5 одновременных соединений
        threads = []
        for i in range(5):
            thread = threading.Thread(target=websocket_worker, args=(i,))
            threads.append(thread)
            thread.start()

        # Ждем завершения всех потоков
        for thread in threads:
            thread.join(timeout=10)

        # Проверяем результаты
        successful_connections = 0
        while not results.empty():
            worker_id, response = results.get()
            assert response["type"] == "p2p_event"
            assert f"worker_{worker_id}" in response["data"]
            successful_connections += 1

        # Должны быть успешные соединения (хотя бы несколько)
        assert successful_connections >= 3, f"Успешных соединений: {successful_connections}"

        # Проверяем ошибки
        error_count = 0
        while not errors.empty():
            worker_id, error = errors.get()
            print(f"Ошибка в worker {worker_id}: {error}")
            error_count += 1

        # Не должно быть слишком много ошибок
        assert error_count < 2, f"Слишком много ошибок: {error_count}"

    def test_load_testing_basic(self, client):
        """Базовое нагрузочное тестирование API"""
        endpoints = [
            '/api/v1/p2p/status',
            '/api/v1/wall/threads?thread_id=general',
            '/api/v1/fs/list/mcp'
        ]

        total_requests = 0
        successful_requests = 0
        response_times = []

        # Выполняем 20 запросов к каждому эндпоинту
        for endpoint in endpoints:
            for i in range(20):
                start_time = time.time()
                response = client.get(endpoint)
                end_time = time.time()

                total_requests += 1
                response_times.append(end_time - start_time)

                if response.status_code in [200, 503]:  # 503 ожидаемо для некоторых эндпоинтов
                    successful_requests += 1

        # Проверяем результаты
        success_rate = successful_requests / total_requests
        avg_response_time = sum(response_times) / len(response_times)
        max_response_time = max(response_times)

        print(f"Всего запросов: {total_requests}")
        print(f"Успешных: {successful_requests}")
        print(f"Процент успеха: {success_rate:.2%}")
        print(f"Среднее время ответа: {avg_response_time:.3f} сек")
        print(f"Максимальное время: {max_response_time:.3f} сек")

        # Проверяем метрики
        assert success_rate >= 0.95, f"Слишком низкий процент успеха: {success_rate:.2%}"
        assert avg_response_time < 1.0, f"Слишком долгое среднее время: {avg_response_time:.3f} сек"
        assert max_response_time < 5.0, f"Слишком долгое максимальное время: {max_response_time:.3f} сек"

    @pytest.mark.asyncio
    async def test_websocket_load_testing(self, client):
        """Нагрузочное тестирование WebSocket"""
        async def websocket_stress_test(client_id: int):
            """Индивидуальный тест WebSocket клиента"""
            try:
                with client.websocket_connect("/ws") as websocket:
                    messages_sent = 0
                    responses_received = 0

                    # Отправляем несколько сообщений
                    for i in range(10):
                        message = {
                            "type": "test",
                            "data": f"client_{client_id}_msg_{i}",
                            "timestamp": time.time()
                        }

                        websocket.send_text(json.dumps(message))
                        messages_sent += 1

                        # Получаем ответ
                        response = websocket.receive_json()
                        if response["type"] == "p2p_event":
                            responses_received += 1

                        await asyncio.sleep(0.01)  # Небольшая задержка

                    return {
                        "client_id": client_id,
                        "messages_sent": messages_sent,
                        "responses_received": responses_received,
                        "success_rate": responses_received / messages_sent if messages_sent > 0 else 0
                    }

            except Exception as e:
                return {
                    "client_id": client_id,
                    "error": str(e),
                    "messages_sent": 0,
                    "responses_received": 0,
                    "success_rate": 0
                }

        # Запускаем 10 одновременных клиентов
        tasks = []
        for i in range(10):
            task = websocket_stress_test(i)
            tasks.append(task)

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Анализируем результаты
        total_messages = 0
        total_responses = 0
        successful_clients = 0
        errors = []

        for result in results:
            if isinstance(result, Exception):
                errors.append(str(result))
                continue

            if "error" in result:
                errors.append(result["error"])
                continue

            total_messages += result["messages_sent"]
            total_responses += result["responses_received"]

            if result["success_rate"] >= 0.8:  # 80% успех
                successful_clients += 1

        print(f"Всего клиентов: {len(results)}")
        print(f"Успешных клиентов: {successful_clients}")
        print(f"Всего сообщений: {total_messages}")
        print(f"Всего ответов: {total_responses}")
        print(f"Общий процент успеха: {total_responses/total_messages:.2%}")
        print(f"Ошибок: {len(errors)}")

        # Проверяем метрики
        assert successful_clients >= 7, f"Слишком мало успешных клиентов: {successful_clients}"
        assert total_responses / total_messages >= 0.8, "Слишком низкий процент успешных ответов"
        assert len(errors) < 3, f"Слишком много ошибок: {len(errors)}"

    def test_error_handling_scenarios(self, client):
        """Тест различных сценариев обработки ошибок"""

        # Тест 1: Некорректный JSON в WebSocket
        with client.websocket_connect("/ws") as websocket:
            websocket.send_text("invalid json message")
            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Invalid JSON format" in response["message"]

        # Тест 2: Неизвестный тип сообщения
        with client.websocket_connect("/ws") as websocket:
            websocket.send_text(json.dumps({"type": "unknown_command"}))
            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Unknown message type" in response["message"]

        # Тест 3: Отсутствующий параметр в API
        response = client.get('/api/v1/wall/threads')  # Без thread_id
        assert response.status_code == 422  # Validation error

        # Тест 4: Несуществующий путь в файловой системе
        response = client.get('/api/v1/fs/list/nonexistent/path')
        assert response.status_code == 404

        print("Все сценарии обработки ошибок прошли успешно!")

    def test_data_consistency(self, client):
        """Тест согласованности данных между компонентами"""

        # Получаем данные из разных эндпоинтов
        wall_response = client.get('/api/v1/wall/threads?thread_id=general')
        status_response = client.get('/api/v1/p2p/status')
        peers_response = client.get('/api/v1/peers')

        # Проверяем согласованность типов данных
        assert isinstance(wall_response.json(), list)
        assert isinstance(status_response.json(), dict)
        assert isinstance(peers_response.json(), list)

        # Проверяем наличие обязательных полей
        status_data = status_response.json()
        required_fields = ['enabled', 'status', 'agent_public_key', 'known_peers_count']
        for field in required_fields:
            assert field in status_data

        print("Проверка согласованности данных прошла успешно!")

    @pytest.mark.asyncio
    async def test_system_resilience(self, client):
        """Тест устойчивости системы к различным нагрузкам"""

        # Тест 1: Быстрое последовательное подключение/отключение
        for i in range(20):
            try:
                with client.websocket_connect("/ws") as websocket:
                    websocket.send_text(json.dumps({"type": "ping"}))
                    response = websocket.receive_json()
                    assert response["type"] == "pong"
                await asyncio.sleep(0.05)  # Короткая задержка
            except Exception as e:
                # Некоторые подключения могут не удаться - это нормально
                print(f"Подключение {i} не удалось: {e}")

        # Тест 2: Смешанная нагрузка на API и WebSocket
        api_tasks = []
        for i in range(10):
            task = asyncio.create_task(self._api_load_task(client, i))
            api_tasks.append(task)

        # Выполняем параллельно
        results = await asyncio.gather(*api_tasks, return_exceptions=True)

        successful_tasks = sum(1 for r in results if not isinstance(r, Exception))
        print(f"Успешных API задач: {successful_tasks}/{len(api_tasks)}")

        assert successful_tasks >= 8, f"Слишком много неудачных API задач: {len(api_tasks) - successful_tasks}"

    async def _api_load_task(self, client, task_id: int):
        """Индивидуальная задача для нагрузочного тестирования API"""
        try:
            # Выполняем несколько API вызовов
            client.get('/api/v1/p2p/status')
            client.get('/api/v1/wall/threads?thread_id=general')
            client.get('/api/v1/fs/list/mcp')

            # Небольшая задержка
            await asyncio.sleep(0.1)
            return f"task_{task_id}_success"

        except Exception as e:
            raise Exception(f"Task {task_id} failed: {e}")

    def test_configuration_scenarios(self, client):
        """Тест различных конфигурационных сценариев"""

        # Тест с различными параметрами запроса
        test_cases = [
            ('/api/v1/wall/threads?thread_id=general&limit=10', 200),
            ('/api/v1/wall/threads?thread_id=general&limit=100', 200),
            ('/api/v1/fs/list/mcp/agents', 200),
            ('/api/v1/fs/list/docs', 200),
        ]

        for endpoint, expected_status in test_cases:
            response = client.get(endpoint)
            assert response.status_code == expected_status, f"Failed for {endpoint}"

        print("Тест конфигурационных сценариев прошел успешно!")
