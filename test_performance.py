#!/usr/bin/env python3
"""
Тестирование производительности улучшенного модуля
"""

import time
import asyncio
from fastapi.testclient import TestClient
from bridge.main import app

def test_api_performance():
    """Тестирование производительности API эндпоинтов"""
    print("=" * 50)
    print("ТЕСТИРОВАНИЕ ПРОИЗВОДИТЕЛЬНОСТИ API")
    print("=" * 50)

    client = TestClient(app)
    endpoints = [
        ("/api/v1/p2p/status", "P2P Status"),
        ("/api/v1/wall/threads?thread_id=general", "Wall Threads"),
        ("/api/v1/peers", "Peers"),
        ("/api/v1/fs/list/mcp", "FS List")
    ]

    for endpoint, name in endpoints:
        print(f"\n=== Тестирование {name} ===")

        # Тест 1: Одиночные запросы
        times = []
        for i in range(10):
            start_time = time.time()
            response = client.get(endpoint)
            end_time = time.time()
            times.append(end_time - start_time)
            assert response.status_code in [200, 503]  # 503 ожидаемо для peers

        avg_time = sum(times) / len(times)
        min_time = min(times)
        max_time = max(times)

        print(f"Среднее время: {avg_time:.4f} сек")
        print(f"Мин. время: {min_time:.4f} сек")
        print(f"Макс. время: {max_time:.4f} сек")

        # Тест 2: Последовательные запросы
        print("\nПоследовательные запросы:")
        start_time = time.time()
        for i in range(50):
            response = client.get(endpoint)
            assert response.status_code in [200, 503]
        end_time = time.time()
        total_time = end_time - start_time
        print(f"Общее время: {total_time:.4f} сек")
        print(f"Запросов в сек: {50/total_time:.2f}")
async def test_websocket_performance():
    """Тестирование производительности WebSocket"""
    print("\n" + "=" * 50)
    print("ТЕСТИРОВАНИЕ ПРОИЗВОДИТЕЛЬНОСТИ WEBSOCKET")
    print("=" * 50)

    client = TestClient(app)

    # Тест 1: Быстрые сообщения
    print("\n=== Тест быстрых сообщений ===")
    with client.websocket_connect("/ws") as websocket:
        message_count = 100
        start_time = time.time()

        for i in range(message_count):
            websocket.send_text(f'{{"type": "test", "data": "msg_{i}"}}')
            response = websocket.receive_json()
            assert response["type"] == "p2p_event"

        end_time = time.time()
        total_time = end_time - start_time
        avg_time = total_time / message_count

        print(f"Общее время: {total_time:.4f} сек")
        print(f"Среднее время на сообщение: {avg_time:.4f} сек")
        print(f"Сообщений в сек: {message_count/total_time:.2f}")

    # Тест 2: Ping-pong тест
    print("\n=== Ping-Pong тест ===")
    with client.websocket_connect("/ws") as websocket:
        ping_count = 50
        start_time = time.time()

        for i in range(ping_count):
            websocket.send_text('{"type": "ping"}')
            response = websocket.receive_json()
            assert response["type"] == "pong"

        end_time = time.time()
        total_time = end_time - start_time
        avg_time = total_time / ping_count

        print(f"Общее время: {total_time:.4f} сек")
        print(f"Среднее время на ping-pong: {avg_time:.4f} сек")
        print(f"Ping-pong в сек: {ping_count/total_time:.2f}")
def test_memory_usage():
    """Тестирование использования памяти"""
    print("\n" + "=" * 50)
    print("АНАЛИЗ ИСПОЛЬЗОВАНИЯ РЕСУРСОВ")
    print("=" * 50)

    import psutil
    import os

    process = psutil.Process(os.getpid())
    initial_memory = process.memory_info().rss / 1024 / 1024  # MB

    print(f"Начальное использование памяти: {initial_memory:.2f} MB")

    # Выполняем несколько операций
    client = TestClient(app)

    for i in range(20):
        client.get("/api/v1/wall/threads?thread_id=general")
        client.get("/api/v1/p2p/status")
        client.get("/api/v1/fs/list/mcp")

    final_memory = process.memory_info().rss / 1024 / 1024  # MB
    memory_diff = final_memory - initial_memory

    print(f"Финальное использование памяти: {final_memory:.2f} MB")
    print(f"Разница: {memory_diff:.2f} MB")
    if memory_diff < 10:  # Менее 10MB
        print("✅ Использование памяти в норме")
    else:
        print("⚠️  Возможно есть утечка памяти")

def main():
    print("🚀 НАЧИНАЕМ КОМПЛЕКСНОЕ ТЕСТИРОВАНИЕ ПРОИЗВОДИТЕЛЬНОСТИ")
    print("=" * 70)

    # Тестируем API производительность
    test_api_performance()

    # Тестируем WebSocket производительность
    asyncio.run(test_websocket_performance())

    # Анализируем использование ресурсов
    test_memory_usage()

    print("\n" + "=" * 70)
    print("✅ ТЕСТИРОВАНИЕ ПРОИЗВОДИТЕЛЬНОСТИ ЗАВЕРШЕНО!")
    print("=" * 70)

if __name__ == "__main__":
    main()
