import os
import json
from typing import Dict, Any, List, Optional
from datetime import datetime

# from .git_tools import GitTools # TODO: Импортировать GitTools

class WallManager:
    def __init__(self, base_wall_path: str = "Sdominanta.net/wall/threads"):
        self.base_wall_path = base_wall_path
        # self.git_tools = GitTools(base_repo_path=base_wall_path) # Инстанс GitTools
        print(f"WallManager initialized. Base wall path: {self.base_wall_path}")

    def _get_thread_path(self, thread_id: str) -> str:
        """
        Возвращает полный путь к директории треда.
        """
        return os.path.join(self.base_wall_path, thread_id)

    def _get_user_profile_path(self, user_id: str) -> str:
        """
        Возвращает полный путь к директории профиля пользователя на стене.
        """
        return os.path.join(self.base_wall_path, f"user_profiles/{user_id}")

    async def post_note(self, thread_id: str, author_id: str, content: Dict[str, Any], is_private: bool = False, recipient_user_id: Optional[str] = None) -> str:
        """
        Публикует новую заметку в указанный тред.
        """
        thread_path = self._get_thread_path(thread_id)
        os.makedirs(thread_path, exist_ok=True) # Убедимся, что директория треда существует

        note_id = f"note_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}_{os.urandom(4).hex()}"
        note_filename = os.path.join(thread_path, f"{note_id}.json")

        note_data = {
            "id": note_id,
            "author_id": author_id,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "content": content,
            "is_private": is_private,
            "recipient_user_id": recipient_user_id
        }

        with open(note_filename, 'w', encoding='utf-8') as f:
            json.dump(note_data, f, ensure_ascii=False, indent=2)
        
        # TODO: После сохранения заметки, возможно, нужно сделать Git commit и push через self.git_tools
        # await self.git_tools.commit_and_push(thread_id, f"Add note {note_id}")

        print(f"WallManager: Заметка {note_id} опубликована в тред {thread_id}.")
        return note_id

    async def get_notes_from_thread(self, thread_id: str, user_id: str, since: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Получает заметки из указанного треда, фильтруя по правам доступа и другим параметрам.
        """
        thread_path = self._get_thread_path(thread_id)
        if not os.path.exists(thread_path):
            return []

        notes = []
        for filename in sorted(os.listdir(thread_path)):
            if filename.endswith(".json"):
                note_file_path = os.path.join(thread_path, filename)
                with open(note_file_path, 'r', encoding='utf-8') as f:
                    note = json.load(f)
                    
                    # Проверка прав доступа для приватных сообщений
                    if note.get("is_private") and note.get("recipient_user_id") != user_id and note.get("author_id") != user_id:
                        continue # Пропускаем приватные сообщения не для этого пользователя

                    # TODO: Добавить проверку на "скрытые" треды, если есть отдельный механизм прав

                    notes.append(note)
                    if len(notes) >= limit:
                        break # Ограничение по количеству
        
        # TODO: Фильтрация по 'since' (дата/время)
        return notes

    async def create_user_profile(self, user_id: str, initial_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Создает новый профиль пользователя на стене.
        """
        profile_path = self._get_user_profile_path(user_id)
        os.makedirs(profile_path, exist_ok=True)
        
        profile_filename = os.path.join(profile_path, "profile.json")
        with open(profile_filename, 'w', encoding='utf-8') as f:
            json.dump(initial_data, f, ensure_ascii=False, indent=2)

        # TODO: Возможно, инициализация Git-репозитория для профиля через self.git_tools
        # await self.git_tools.init_repo(f"user_profiles/{user_id}")
        # await self.git_tools.commit_and_push(f"user_profiles/{user_id}", "Initial profile commit")

        print(f"WallManager: Профиль пользователя {user_id} создан.")
        return {"status": "profile_created", "user_id": user_id}

    async def get_user_profile(self, user_id: str) -> Optional[Dict[str, Any]]:
        """
        Получает профиль пользователя.
        """
        profile_path = self._get_user_profile_path(user_id)
        profile_filename = os.path.join(profile_path, "profile.json")
        
        if os.path.exists(profile_filename):
            with open(profile_filename, 'r', encoding='utf-8') as f:
                return json.load(f)
        return None

    async def update_user_profile(self, user_id: str, new_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Обновляет профиль пользователя.
        """
        profile_path = self._get_user_profile_path(user_id)
        profile_filename = os.path.join(profile_path, "profile.json")

        if os.path.exists(profile_filename):
            current_profile = await self.get_user_profile(user_id)
            current_profile.update(new_data) # Объединяем данные
            with open(profile_filename, 'w', encoding='utf-8') as f:
                json.dump(current_profile, f, ensure_ascii=False, indent=2)
            
            # TODO: Git commit и push через self.git_tools
            # await self.git_tools.commit_and_push(f"user_profiles/{user_id}", "Update profile data")

            print(f"WallManager: Профиль пользователя {user_id} обновлен.")
            return {"status": "profile_updated", "user_id": user_id}
        return {"status": "error", "message": "User profile not found"}

    # Дополнительные методы: управление тредами (создание, удаление, изменение видимости),
    # аудит истории изменений Git и т.д.
