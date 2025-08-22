import os
import asyncio
from ..llm_connector.ollama_client import OllamaClient
from typing import Dict, Any

class SecurityAgent:
    def __init__(self, ollama_client: OllamaClient, log_path: str = "/var/log/auth.log"):
        self.ollama_client = ollama_client
        self.name = "SecurityAgent"
        self.log_path = log_path # Путь к логам SSH, Nginx, и т.д.
        self.system_prompt = (
            "Ты — аналитик службы безопасности проекта Sdominanta.net. "
            "Твоя задача — непрерывно мониторить системные логи, "
            "выявлять аномалии и потенциальные угрозы, такие как попытки взлома, DDoS, "
            "странные запросы, и сообщать о них."
        )
        self.last_read_position = 0 # Для отслеживания прочитанных логов
        print(f"{self.name} initialized. Monitoring logs from: {self.log_path}")

    async def _read_new_logs(self) -> str:
        """Читает новые строки из лог-файла."""
        try:
            # Для простоты, здесь читаем весь файл, в реальном приложении - новые строки
            with open(self.log_path, 'r') as f:
                f.seek(self.last_read_position)
                new_logs = f.read()
                self.last_read_position = f.tell()
                return new_logs
        except FileNotFoundError:
            return f"Error: Log file not found at {self.log_path}"
        except Exception as e:
            return f"Error reading log file: {e}"

    async def analyze_logs(self) -> Dict[str, Any]:
        """Анализирует новые логи на предмет угроз."""
        new_logs = await self._read_new_logs()
        if not new_logs.strip():
            return {"status": "no_new_logs"}

        prompt = (
            f"Проанализируй следующие логи на предмет подозрительной активности, "
            f"попыток взлома, DDoS, или необычных событий. Если найдешь что-то, "
            f"опиши угрозу и предложи возможные действия. Если угроз нет, так и скажи.\n\n"
            f"Логи:\n```\n{new_logs}\n```"
        )
        response = await self.ollama_client.generate(prompt, system_message=self.system_prompt)
        print(f"{self.name} analyzed logs:\n{response}")
        # TODO: Добавить логику для отправки уведомлений
        return {"analysis": response, "status": "logs_analyzed"}

    async def run_monitoring(self, interval_seconds: int = 300):
        """Запускает непрерывный мониторинг логов."""
        while True:
            await self.analyze_logs()
            await asyncio.sleep(interval_seconds)
