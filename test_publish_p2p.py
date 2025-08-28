#!/usr/bin/env python3
import requests
import json
import yaml
import os
from datetime import datetime

BASE_URL = "http://127.0.0.1:8000"
CONFIG_PATH = "bridge/config.yaml"

def test_publish_with_p2p():
    print("=== ТЕСТИРОВАНИЕ ПУБЛИКАЦИИ С P2P ===")

    # 1. Временно включаем P2P
    print("1. Временно включаем P2P...")
    with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)

    original_p2p = config.get('p2p_enabled', False)
    config['p2p_enabled'] = True

    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        yaml.dump(config, f, default_flow_style=False)

    print(f"   P2P изменен: {original_p2p} -> True")

    print("\n2. Перезапускаем сервер...")
    print("   Остановите сервер (Ctrl+C) и запустите снова:")
    print("   .\\.venv\\Scripts\\python -m uvicorn bridge.main:app --port 8000")
    input("   Нажмите Enter после перезапуска сервера...")

    # Создаем тестовую заметку
    note_data = {
        "id": "test_p2p_001",
        "pubkey": "test_pubkey_123",
        "created_at": datetime.utcnow().isoformat() + "Z",
        "kind": 1,
        "tags": [["t", "general"], ["author", "test_user"]],
        "content": "Это тестовая заметка с включенным P2P!",
        "sig": "test_signature_abc"
    }

    print("\n3. Публикация заметки:")
    try:
        response = requests.post(
            f"{BASE_URL}/api/v1/wall/publish",
            json={
                "author_id": "test_user",
                "thread_id": "general",
                "content": note_data,
                "is_private": False
            }
        )

        print(f"   Статус: {response.status_code}")
        if response.status_code == 200:
            result = response.json()
            print(f"   Результат: {result}")
            if result.get("status") == "note_published":
                print("   ✅ Заметка успешно опубликована!")
                print(f"   ID заметки: {result.get('note_id')}")
        else:
            print(f"   Ошибка: {response.text}")

    except Exception as e:
        print(f"   Ошибка подключения: {e}")

    print("\n4. Проверка заметок после публикации:")
    try:
        response = requests.get(f"{BASE_URL}/api/v1/wall/threads?thread_id=general")
        print(f"   Статус: {response.status_code}")
        if response.status_code == 200:
            notes = response.json()
            print(f"   Всего заметок: {len(notes)}")
            for i, note in enumerate(notes):
                print(f"   Заметка {i+1}: ID={note.get('id', 'N/A')}")
                if note.get('id') == 'test_p2p_001':
                    print("   ✅ Тестовая заметка найдена!")
                    break
            else:
                print("   ❌ Тестовая заметка не найдена")
        else:
            print(f"   Ошибка: {response.text}")

    except Exception as e:
        print(f"   Ошибка подключения: {e}")

    # 5. Восстанавливаем оригинальную конфигурацию
    print("\n5. Восстанавливаем конфигурацию...")
    config['p2p_enabled'] = original_p2p

    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        yaml.dump(config, f, default_flow_style=False)

    print(f"   P2P восстановлен: True -> {original_p2p}")

if __name__ == "__main__":
    test_publish_with_p2p()
