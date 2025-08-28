#!/usr/bin/env python3
import asyncio
from bridge.api.wall import WallAPI

async def test_wall_direct():
    print("=== ПРЯМОЕ ТЕСТИРОВАНИЕ WallAPI ===")

    # Создаем экземпляр WallAPI
    wall_api = WallAPI()

    # Тестируем получение заметок из треда general
    print("\n1. Получение заметок из треда 'general':")
    notes = await wall_api.get_thread_notes("general")
    print(f"   Найдено заметок: {len(notes)}")

    if notes:
        for i, note in enumerate(notes):
            print(f"   Заметка {i+1}: ID={note.get('id', 'N/A')}, Content={note.get('content', 'N/A')[:50]}...")
    else:
        print("   Заметки не найдены")

if __name__ == "__main__":
    asyncio.run(test_wall_direct())
