from typing import Dict, Any, List, Optional
import os
import json
from datetime import datetime
import uuid # Добавляем uuid для генерации уникальных ID заметок
from fastapi import HTTPException # Добавляем HTTPException для обработки ошибок

from mcp.tools.git_tools import GitTools # Импортируем GitTools

# from ..utils.wall_manager import WallManager # TODO: Нужен модуль для управления стеной
# from ..utils.git_tools import GitTools # TODO: Нужен модуль для работы с Git

class WallAPI:
    def __init__(self, wall_manager=None, git_tools=None):
        self.wall_manager = wall_manager   # Инстанс менеджера стены
        self.git_tools = git_tools if git_tools else GitTools(base_repo_path="wall")         # Инстанс инструментов Git
        self.base_wall_path = os.getenv("WALL_PATH", "wall/threads")

    async def publish_note(self, author_id: str, thread_id: str, content: Dict[str, Any], is_private: bool = False, recipient_user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Публикует заметку на стену или в личный тред.
        Если is_private=True и recipient_user_id указан, публикуется как личное сообщение.
        """
        print(f"WallAPI: Публикация заметки от {author_id} в тред {thread_id}. Приватное: {is_private}.")
        
        # TODO: Добавить валидацию подписи заметки перед публикацией, используя verify_wall_signatures.py
        # if not self.git_tools.verify_signature(content): # Пример вызова
        #     return {"status": "error", "message": "Invalid note signature"}

        if is_private and recipient_user_id:
            # TODO: Реализовать логику записи в личный тред пользователя
            # note_id = await self.wall_manager.post_private_message(author_id, recipient_user_id, content)
            print(f"Публикация личного сообщения для {recipient_user_id}.")
            return {"status": "private_note_published", "note_id": "mock_private_note_id"}
        else:
            # Реализуем логику записи в общий или скрытый тред и коммита в Git
            thread_dir = os.path.join(self.base_wall_path, thread_id)
            os.makedirs(thread_dir, exist_ok=True)

            # Генерируем уникальный ID для заметки и имя файла
            note_id = content.get("id", str(uuid.uuid4()))
            # Добавляем created_at, если его нет
            if "created_at" not in content:
                content["created_at"] = datetime.utcnow().isoformat() + "Z"
            
            filename = f"{note_id}.json"
            filepath = os.path.join(thread_dir, filename)

            try:
                with open(filepath, 'w', encoding='utf-8') as f:
                    json.dump(content, f, ensure_ascii=False, indent=2)
                
                # Коммит и пуш через GitTools
                commit_message = f"Add note {note_id} to thread {thread_id} by {author_id}"
                git_result = await self.git_tools.commit_and_push(repo_name=".", message=commit_message, files_to_add=[os.path.join(thread_id, filename)]) # Передаем относительный путь от base_repo_path (wall)

                if git_result.get("status") == "success":
                    print(f"WallAPI: Заметка {note_id} опубликована в тред {thread_id} и закоммичена.")
                    return {"status": "note_published", "note_id": note_id, "git_status": "success"}
                else:
                    print(f"WallAPI: Заметка {note_id} опубликована локально, но ошибка Git: {git_result.get("message")}")
                    raise HTTPException(status_code=500, detail=f"Ошибка Git при публикации: {git_result.get("message")}")

            except Exception as e:
                print(f"WallAPI: Ошибка публикации заметки {note_id} в тред {thread_id}: {e}")
                raise HTTPException(status_code=500, detail=f"Ошибка публикации заметки: {e}")

    async def get_thread_notes(self, thread_id: str, since: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Получает заметки из указанного треда.
        """
        thread_path = os.path.join(self.base_wall_path, thread_id)
        notes = []

        if not os.path.isdir(thread_path):
            print(f"WallAPI: Тред не найден: {thread_id}")
            return []

        for filename in sorted(os.listdir(thread_path)):
            if filename.endswith(".json"):
                filepath = os.path.join(thread_path, filename)
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        note = json.load(f)
                        # TODO: Добавить проверку подписи и валидацию по схеме
                        notes.append(note)
                except json.JSONDecodeError as e:
                    print(f"WallAPI: Ошибка парсинга JSON в {filepath}: {e}")
                except Exception as e:
                    print(f"WallAPI: Ошибка чтения файла {filepath}: {e}")
        
        if since:
            since_dt = datetime.fromisoformat(since.replace('Z', '+00:00'))
            notes = [note for note in notes if datetime.fromisoformat(note.get('created_at', '').replace('Z', '+00:00')) >= since_dt]

        return notes[-limit:]  # Возвращаем последние 'limit' заметок (или все, если их меньше)

    async def create_thread(self, owner_id: str, thread_name: str, is_private: bool = False, associated_git_repo_url: Optional[str] = None) -> Dict[str, Any]:
        """
        Создает новый тред (возможно, как Git-проект).
        """
        print(f"WallAPI: Создание нового треда '{thread_name}' от {owner_id}. Приватный: {is_private}.")
        # TODO: Реализовать создание нового Git-репозитория или директории для треда через git_tools
        # thread_id = await self.wall_manager.create_thread(owner_id, thread_name, is_private, associated_git_repo_url)
        # if associated_git_repo_url:
        #     await self.git_tools.create_git_repo(thread_id) # Пример
        print(f"Тред '{thread_name}' создан.")
        return {"status": "thread_created", "thread_id": "mock_thread_id"}

    async def get_user_profile(self, user_id: str) -> Dict[str, Any]:
        """
        Получает профиль пользователя.
        """
        print(f"WallAPI: Запрос профиля пользователя {user_id}.")
        # TODO: Реализовать чтение профиля пользователя из Git-репозитория/файла через wall_manager
        # profile_data = await self.wall_manager.get_user_profile(user_id)
        # return profile_data
        return {"user_id": user_id, "nickname": "TestUser", "bio": "Разработчик Sdominanta.net"} # Заглушка

    async def update_user_profile(self, user_id: str, profile_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Обновляет профиль пользователя.
        """
        print(f"WallAPI: Обновление профиля пользователя {user_id}.")
        # TODO: Реализовать запись профиля пользователя в Git-репозиторий/файл через wall_manager
        # await self.wall_manager.update_user_profile(user_id, profile_data)
        # await self.git_tools.commit_and_push(f"user_profile_{user_id}", "Update profile") # Пример
        print(f"Профиль пользователя {user_id} обновлен.")
        return {"status": "profile_updated", "user_id": user_id}

    # Дополнительные методы: управление правами доступа к тредам, подписка на события стены и т.д.
