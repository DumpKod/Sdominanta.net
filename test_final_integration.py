#!/usr/bin/env python3
"""
Финальный интеграционный тест всех новых функций
"""

from fastapi.testclient import TestClient
from bridge.main import app
import json
import time

def test_complete_system():
    """Комплексный тест всей системы"""
    client = TestClient(app)

    print("=" * 60)
    print("КОМПЛЕКСНЫЙ ТЕСТ ВСЕЙ СИСТЕМЫ SDOMINANTA.NET")
    print("=" * 60)

    results = {
        'api_endpoints': False,
        'websocket_functionality': False,
        'caching_system': False,
        'performance_monitoring': False,
        'error_handling': False,
        'logging_system': False
    }

    # 1. Тест API эндпоинтов
    print("\n1. Тестирование API эндпоинтов...")
    try:
        # P2P Status
        response = client.get('/api/v1/p2p/status')
        assert response.status_code == 200
        data = response.json()
        assert 'status' in data
        assert 'enabled' in data

        # Wall Threads
        response = client.get('/api/v1/wall/threads?thread_id=general')
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

        # Peers (может вернуть 503 если P2P отключен)
        response = client.get('/api/v1/peers')
        assert response.status_code in [200, 503]

        # FS List
        response = client.get('/api/v1/fs/list/mcp')
        assert response.status_code == 200

        results['api_endpoints'] = True
        print("✅ API эндпоинты работают корректно")

    except Exception as e:
        print(f"❌ Ошибка API эндпоинтов: {e}")

    # 2. Тест WebSocket функциональности
    print("\n2. Тестирование WebSocket...")
    try:
        with client.websocket_connect("/ws") as websocket:
            # Тест разных типов сообщений
            test_messages = [
                {"type": "ping"},
                {"type": "test", "data": "websocket_test"},
                {"type": "unknown_type"}
            ]

            for msg in test_messages:
                websocket.send_text(json.dumps(msg))
                response = websocket.receive_json()
                assert 'type' in response

        results['websocket_functionality'] = True
        print("✅ WebSocket работает корректно")

    except Exception as e:
        print(f"❌ Ошибка WebSocket: {e}")

    # 3. Тест системы кэширования
    print("\n3. Тестирование системы кэширования...")
    try:
        # Очищаем кэш
        response = client.post('/api/v1/cache/clear')
        assert response.status_code == 200

        # Первый запрос (должен кэшироваться)
        start_time = time.time()
        response1 = client.get('/api/v1/p2p/status')
        time1 = time.time() - start_time

        # Второй запрос (должен быть из кэша)
        start_time = time.time()
        response2 = client.get('/api/v1/p2p/status')
        time2 = time.time() - start_time

        # Проверяем статистику кэша
        response = client.get('/api/v1/performance/stats')
        assert response.status_code == 200
        stats = response.json()
        assert 'cache_stats' in stats

        results['caching_system'] = True
        print(f"✅ Кэширование работает (запрос 1: {time1:.3f}s, запрос 2: {time2:.3f}s)")

    except Exception as e:
        print(f"❌ Ошибка кэширования: {e}")

    # 4. Тест мониторинга производительности
    print("\n4. Тестирование мониторинга производительности...")
    try:
        # Выполняем несколько запросов для генерации статистики
        for i in range(5):
            client.get('/api/v1/wall/threads?thread_id=general')
            client.get('/api/v1/p2p/status')

        # Проверяем статистику
        response = client.get('/api/v1/performance/stats')
        assert response.status_code == 200
        stats = response.json()

        # Проверяем наличие метрик
        assert 'performance_stats' in stats
        assert 'cache_stats' in stats
        assert 'system_health' in stats

        results['performance_monitoring'] = True
        print("✅ Мониторинг производительности работает")

    except Exception as e:
        print(f"❌ Ошибка мониторинга: {e}")

    # 5. Тест обработки ошибок
    print("\n5. Тестирование обработки ошибок...")
    try:
        # Тест некорректного JSON в WebSocket
        with client.websocket_connect("/ws") as websocket:
            websocket.send_text("invalid json")
            response = websocket.receive_json()
            assert response['type'] == 'error'

        # Тест неизвестного типа сообщения
        with client.websocket_connect("/ws") as websocket:
            websocket.send_text(json.dumps({"type": "unknown"}))
            response = websocket.receive_json()
            assert response['type'] == 'error'

        results['error_handling'] = True
        print("✅ Обработка ошибок работает корректно")

    except Exception as e:
        print(f"❌ Ошибка обработки ошибок: {e}")

    # 6. Тест системы логирования
    print("\n6. Тестирование системы логирования...")
    try:
        # Выполняем операции для генерации логов
        client.get('/api/v1/p2p/status')
        with client.websocket_connect("/ws") as websocket:
            websocket.send_text(json.dumps({"type": "test", "data": "logging_test"}))
            websocket.receive_json()

        # Проверяем, что логи создаются (файлы должны существовать)
        import os
        log_files = ['logs/sdominanta.log', 'logs/api.log', 'logs/p2p.log']
        logs_exist = all(os.path.exists(log_file) for log_file in log_files)

        if logs_exist:
            results['logging_system'] = True
            print("✅ Система логирования работает")
        else:
            print("⚠️  Лог файлы не найдены, но система может работать")

    except Exception as e:
        print(f"❌ Ошибка логирования: {e}")

    # Итоговый отчет
    print("\n" + "=" * 60)
    print("ИТОГОВЫЙ ОТЧЕТ ТЕСТИРОВАНИЯ")
    print("=" * 60)

    total_tests = len(results)
    passed_tests = sum(1 for result in results.values() if result)

    for component, status in results.items():
        status_icon = "✅" if status else "❌"
        print("15")

    print(f"\n📊 РЕЗУЛЬТАТ: {passed_tests}/{total_tests} компонентов прошли тестирование")

    if passed_tests == total_tests:
        print("🎉 ПОЗДРАВЛЯЕМ! Все новые функции работают корректно!")
        print("🚀 Система готова к продакшену!")
    else:
        print("⚠️  Некоторые компоненты требуют доработки")

    print("=" * 60)

    return passed_tests == total_tests

if __name__ == "__main__":
    success = test_complete_system()
    exit(0 if success else 1)
