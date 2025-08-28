#!/usr/bin/env python3
"""
Простое тестирование системы производительности
"""

from fastapi.testclient import TestClient
from bridge.main import app
import time

def test_performance():
    client = TestClient(app)

    print("=" * 50)
    print("ТЕСТИРОВАНИЕ ПРОИЗВОДИТЕЛЬНОСТИ")
    print("=" * 50)

    # Тест 1: Проверка эндпоинта статистики
    print("\n1. Статистика производительности:")
    response = client.get('/api/v1/performance/stats')
    print(f"   Статус: {response.status_code}")
    if response.status_code == 200:
        stats = response.json()
        api_cache = stats["cache_stats"]["api_cache"]
        wall_cache = stats["cache_stats"]["wall_cache"]
        print(f"   API кэш: {api_cache['size']}/{api_cache['max_size']}")
        print(f"   Wall кэш: {wall_cache['size']}/{wall_cache['max_size']}")
        print(f"   Активных задач: {stats['active_tasks_count']}")

    # Тест 2: Замер производительности
    print("\n2. Тестирование скорости ответа:")
    times = []
    for i in range(3):
        start_time = time.time()
        response = client.get('/api/v1/p2p/status')
        end_time = time.time()
        if response.status_code == 200:
            times.append(end_time - start_time)
            print(".4f")
        else:
            print(f"   Запрос {i+1}: Ошибка {response.status_code}")

    if times:
        avg_time = sum(times) / len(times)
        print(".4f")

    # Тест 3: Очистка кэша
    print("\n3. Очистка кэша:")
    response = client.post('/api/v1/cache/clear')
    print(f"   Статус: {response.status_code}")
    if response.status_code == 200:
        print("   ✅ Кэш успешно очищен")

    print("\n" + "=" * 50)
    print("✅ Тестирование завершено!")
    print("=" * 50)

if __name__ == "__main__":
    test_performance()
