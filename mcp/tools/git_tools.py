import asyncio
import os
from typing import List, Dict, Any, Optional

class GitTools:
    def __init__(self, base_repo_path: str = "Sdominanta.net/wall"):
        self.base_repo_path = base_repo_path
        print(f"GitTools initialized. Base repository path: {self.base_repo_path}")

    async def _run_git_command(self, repo_path: str, command: List[str]) -> tuple[int, str, str]:
        """
        Выполняет команду Git в указанной директории репозитория.
        Возвращает код возврата, stdout и stderr.
        """
        full_command = ["git"] + command
        proc = await asyncio.create_subprocess_exec(
            *full_command,
            cwd=repo_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()
        return proc.returncode, stdout.decode().strip(), stderr.decode().strip()

    async def init_repo(self, repo_name: str) -> Dict[str, Any]:
        """
        Инициализирует новый Git-репозиторий для треда или профиля пользователя.
        """
        repo_path = os.path.join(self.base_repo_path, repo_name)
        os.makedirs(repo_path, exist_ok=True) # Создаем директорию, если ее нет
        
        returncode, stdout, stderr = await self._run_git_command(repo_path, ["init"])
        if returncode == 0:
            print(f"GitTools: Репозиторий '{repo_name}' инициализирован.")
            return {"status": "success", "repo_path": repo_path}
        else:
            print(f"GitTools: Ошибка инициализации репозитория '{repo_name}': {stderr}")
            return {"status": "error", "message": stderr}

    async def clone_repo(self, repo_url: str, local_path: str) -> Dict[str, Any]:
        """
        Клонирует существующий Git-репозиторий.
        """
        os.makedirs(local_path, exist_ok=True)
        returncode, stdout, stderr = await self._run_git_command(".", ["clone", repo_url, local_path]) # Клонируем в указанный local_path
        if returncode == 0:
            print(f"GitTools: Репозиторий '{repo_url}' клонирован в '{local_path}'.")
            return {"status": "success", "local_path": local_path}
        else:
            print(f"GitTools: Ошибка клонирования репозитория '{repo_url}': {stderr}")
            return {"status": "error", "message": stderr}

    async def commit_and_push(self, repo_name: str, message: str, files_to_add: Optional[List[str]] = None) -> Dict[str, Any]:
        """
        Добавляет файлы, делает коммит и отправляет изменения в удаленный репозиторий.
        """
        repo_path = os.path.join(self.base_repo_path, repo_name)
        
        if not os.path.exists(repo_path):
            return {"status": "error", "message": f"Репозиторий {repo_path} не найден."}

        # Добавляем файлы
        if files_to_add:
            for f in files_to_add:
                await self._run_git_command(repo_path, ["add", f])
        else:
            await self._run_git_command(repo_path, ["add", "."])
        
        # Коммит
        returncode, stdout, stderr = await self._run_git_command(repo_path, ["commit", "-m", message])
        if returncode != 0 and "nothing to commit" not in stdout and "nothing to commit" not in stderr:
            print(f"GitTools: Ошибка коммита в репозитории '{repo_name}': {stderr}")
            return {"status": "error", "message": f"Ошибка коммита: {stderr}"}
        
        # Пуш
        returncode, stdout, stderr = await self._run_git_command(repo_path, ["push", "origin", "main"]) # Предполагаем ветку main
        if returncode == 0:
            print(f"GitTools: Изменения в репозитории '{repo_name}' отправлены.")
            return {"status": "success", "repo_name": repo_name}
        else:
            print(f"GitTools: Ошибка отправки изменений в репозитории '{repo_name}': {stderr}")
            return {"status": "error", "message": f"Ошибка пуша: {stderr}"}

    async def pull_repo(self, repo_name: str) -> Dict[str, Any]:
        """
        Подтягивает изменения из удаленного репозитория.
        """
        repo_path = os.path.join(self.base_repo_path, repo_name)
        if not os.path.exists(repo_path):
            return {"status": "error", "message": f"Репозиторий {repo_path} не найден."}

        returncode, stdout, stderr = await self._run_git_command(repo_path, ["pull"])
        if returncode == 0:
            print(f"GitTools: Изменения в репозитории '{repo_name}' подтянуты.")
            return {"status": "success", "repo_name": repo_name}
        else:
            print(f"GitTools: Ошибка подтягивания изменений в репозитории '{repo_name}': {stderr}")
            return {"status": "error", "message": stderr}

    # Дополнительные методы: управление ветками, слияния, разрешение конфликтов и т.д.
