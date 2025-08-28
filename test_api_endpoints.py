#!/usr/bin/env python3
"""
Тестирование всех API эндпоинтов после улучшений
"""

from fastapi.testclient import TestClient
from bridge.main import app
import json

def test_api_endpoints():
    client = TestClient(app)

    print("=" * 50)
    print("КОМПЛЕКСНОЕ ТЕСТИРОВАНИЕ API ЭНДПОИНТОВ")
    print("=" * 50)

    # Тестируем P2P status эндпоинт
    print("\n=== Тестирование P2P Status ===")
    response = client.get('/api/v1/p2p/status')
    print(f"Статус: {response.status_code}")

    if response.status_code == 200:
        data = response.json()
        print(f"P2P включен: {data['enabled']}")
        print(f"Статус подключения: {data['status']}")
        print(f"Количество пиров: {data['known_peers_count']}")
        print(f"Daemon URL: {data['daemon_url']}")
        if data['error']:
            print(f"Ошибка: {data['error']}")
    else:
        print(f"Ошибка ответа: {response.text}")

    # Тестируем Wall Threads
    print("\n=== Тестирование Wall Threads ===")
    response = client.get('/api/v1/wall/threads?thread_id=general')
    print(f"Статус: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        print(f"Количество заметок: {len(data)}")

    # Тестируем Peers
    print("\n=== Тестирование Peers ===")
    response = client.get('/api/v1/peers')
    print(f"Статус: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        print(f"Peers: {data}")
    elif response.status_code == 503:
        print("P2P сервис не включен (ожидаемое поведение)")

    # Тестируем FS List
    print("\n=== Тестирование FS List ===")
    response = client.get('/api/v1/fs/list/mcp')
    print(f"Статус: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        print(f"Директория: {data['directory']}")
        print(f"Содержимое: {len(data['contents'])} элементов")
        for item in data['contents'][:3]:  # Показываем первые 3 элемента
            print(f"  - {item['name']} ({item['type']})")
    else:
        print(f"Ошибка: {response.text}")

    print("\n" + "=" * 50)
    print("✅ Тестирование завершено!")
    print("=" * 50)

if __name__ == "__main__":
    test_api_endpoints()
