#!/usr/bin/env python3
import requests
import json

BASE_URL = "http://127.0.0.1:8000"

def test_api():
    print("=== ТЕСТИРОВАНИЕ BRIDGE API ===\n")

    # 1. Чтение заметок стены
    print("1. Чтение заметок стены:")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/wall/threads?thread_id=general")
        print(f"   Статус: {r.status_code}")
        if r.status_code == 200:
            data = r.json()
            print(f"   Заметок: {len(data)}")
            if data:
                print(f"   Первая заметка ID: {data[0]['id']}")
                print(f"   Содержание: {data[0]['content'][:50]}...")
        else:
            print(f"   Ошибка: {r.text}")
    except Exception as e:
        print(f"   Ошибка подключения: {e}")

    print()

    # 2. Список пиров
    print("2. Список пиров:")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/peers")
        print(f"   Статус: {r.status_code}")
        if r.status_code == 503:
            print("   ✅ Корректно: P2P отключен")
        else:
            print(f"   Ответ: {r.text}")
    except Exception as e:
        print(f"   Ошибка подключения: {e}")

    print()

    # 3. Файловый листинг
    print("3. Файловый листинг:")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/fs/list/mcp/agents")
        print(f"   Статус: {r.status_code}")
        if r.status_code == 200:
            data = r.json()
            print(f"   Директория: {data.get('directory', 'N/A')}")
            files = [item for item in data.get('contents', []) if item['type'] == 'file']
            dirs = [item for item in data.get('contents', []) if item['type'] == 'directory']
            print(f"   Файлов: {len(files)}, Директорий: {len(dirs)}")
        else:
            print(f"   Ошибка: {r.text}")
    except Exception as e:
        print(f"   Ошибка подключения: {e}")

    print()

    # 4. Информация о сервере
    print("4. Доступ к API:")
    print(f"   🌐 Swagger UI: {BASE_URL}/docs")
    print(f"   📚 ReDoc: {BASE_URL}/redoc")
    print(f"   🔌 WebSocket: ws://127.0.0.1:8000/ws")

if __name__ == "__main__":
    test_api()
