#!/usr/bin/env python3
import requests
import json
from datetime import datetime

BASE_URL = "http://127.0.0.1:8000"

def test_publish_note():
    print("=== ТЕСТИРОВАНИЕ ПУБЛИКАЦИИ ЗАМЕТКИ ===")

    # Создаем тестовую заметку
    note_data = {
        "id": "test_001",
        "pubkey": "test_pubkey_123",
        "created_at": datetime.utcnow().isoformat() + "Z",
        "kind": 1,
        "tags": [["t", "general"], ["author", "test_user"]],
        "content": "Это тестовая заметка, опубликованная через API Bridge!",
        "sig": "test_signature_abc"
    }

    print("1. Публикация заметки:")
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

    print("\n2. Проверка, что заметка появилась в списке:")
    try:
        response = requests.get(f"{BASE_URL}/api/v1/wall/threads?thread_id=general")
        print(f"   Статус: {response.status_code}")
        if response.status_code == 200:
            notes = response.json()
            print(f"   Всего заметок: {len(notes)}")
            for i, note in enumerate(notes):
                print(f"   Заметка {i+1}: ID={note.get('id', 'N/A')}")
                if note.get('id') == 'test_001':
                    print("   ✅ Тестовая заметка найдена!")
                    break
            else:
                print("   ❌ Тестовая заметка не найдена")
        else:
            print(f"   Ошибка: {response.text}")

    except Exception as e:
        print(f"   Ошибка подключения: {e}")

if __name__ == "__main__":
    test_publish_note()
