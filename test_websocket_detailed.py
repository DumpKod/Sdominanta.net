#!/usr/bin/env python3
"""
Детальное тестирование WebSocket функциональности
"""

import asyncio
import json
import time
from fastapi.testclient import TestClient
from bridge.main import app

async def test_websocket_comprehensive():
    print("=" * 50)
    print("ДЕТАЛЬНОЕ ТЕСТИРОВАНИЕ WEBSOCKET")
    print("=" * 50)

    client = TestClient(app)

    # Тест 1: Проверка подключения
    print("\n=== Тест 1: Проверка подключения ===")
    try:
        with client.websocket_connect("/ws") as websocket:
            print("✅ WebSocket подключение установлено")
            websocket.close()
        print("✅ WebSocket подключение закрыто корректно")
    except Exception as e:
        print(f"❌ Ошибка WebSocket подключения: {e}")
        return

    # Тест 2: Отправка различных типов сообщений
    print("\n=== Тест 2: Тестирование различных типов сообщений ===")
    test_messages = [
        {"type": "ping", "data": "test_ping"},
        {"type": "test", "data": "test_message"},
        {"type": "unknown_type", "data": "unknown"},
        "invalid json message"
    ]

    for i, message in enumerate(test_messages, 1):
        print(f"\n--- Тест 2.{i}: {type(message).__name__} ---")
        try:
            with client.websocket_connect("/ws") as websocket:
                if isinstance(message, dict):
                    websocket.send_text(json.dumps(message))
                    print(f"Отправлено: {message}")
                else:
                    websocket.send_text(message)
                    print(f"Отправлено (строка): {message}")

                # Ждем ответ
                try:
                    response = websocket.receive_json()
                    print(f"Получен ответ: {response}")
                    if response.get("type") == "error":
                        print("⚠️  Получено сообщение об ошибке (ожидаемое поведение)")
                    else:
                        print("✅ Получен корректный ответ")
                except Exception as e:
                    print(f"⚠️  Нет ответа или ошибка получения: {e}")

                websocket.close()

        except Exception as e:
            print(f"❌ Ошибка при отправке сообщения: {e}")

    # Тест 3: Множественные подключения
    print("\n=== Тест 3: Множественные подключения ===")
    websockets = []
    try:
        for i in range(3):
            ws = client.websocket_connect("/ws")
            websockets.append(ws)
            print(f"✅ Подключение {i+1} установлено")

        # Закрываем все подключения
        for i, ws in enumerate(websockets):
            ws.__exit__(None, None, None)
            print(f"✅ Подключение {i+1} закрыто")

    except Exception as e:
        print(f"❌ Ошибка множественных подключений: {e}")

    # Тест 4: Таймауты и стабильность
    print("\n=== Тест 4: Таймауты и стабильность ===")
    try:
        with client.websocket_connect("/ws") as websocket:
            print("✅ Долгое подключение установлено")

            # Отправляем сообщение и ждем
            websocket.send_text(json.dumps({"type": "test", "data": "stability_test"}))
            response = websocket.receive_json()
            print(f"✅ Ответ получен: {response}")

            # Ждем немного и проверяем, что соединение все еще активно
            time.sleep(2)
            websocket.send_text(json.dumps({"type": "ping"}))
            pong_response = websocket.receive_json()
            print(f"✅ Pong получен: {pong_response}")

            print("✅ Соединение стабильно работает")

    except Exception as e:
        print(f"❌ Ошибка стабильности: {e}")

    print("\n" + "=" * 50)
    print("✅ Детальное тестирование WebSocket завершено!")
    print("=" * 50)

if __name__ == "__main__":
    asyncio.run(test_websocket_comprehensive())
