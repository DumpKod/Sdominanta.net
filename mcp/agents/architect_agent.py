import os
from ..llm_connector.ollama_client import OllamaClient
from typing import Dict, Any

class ChiefArchitectAgent:
    def __init__(self, ollama_client: OllamaClient):
        self.ollama_client = ollama_client
        self.name = "ChiefArchitectAgent"
        self.system_prompt = (
            "Ты — главный архитектор проекта Sdominanta.net. "
            "Твоя задача — брать общие цели, разбивать их на детализированные технические шаги, "
            "создавать план выполнения и распределять подзадачи между другими агентами-специалистами."
        )
        print(f"{self.name} initialized.")

    async def plan_task(self, high_level_goal: str) -> Dict[str, Any]:
        """Разбивает высокоуровневую цель на детализированный план."""
        prompt = (
            f"Высокоуровневая цель: \"{high_level_goal}\"\n"
            "Разбей эту цель на детализированный, пошаговый план выполнения, "
            "который можно распределить между специалистами."+
            "Предложи список подзадач для CodeWriterAgent, TesterAgent и ResearchAgent."
        )
        response = await self.ollama_client.generate(prompt, system_message=self.system_prompt)
        # TODO: Распарсить ответ в структурированный план
        print(f"{self.name} generated plan for '{high_level_goal}':\n{response}")
        return {"plan": response, "status": "planning_complete"}

    # Дополнительные методы: review_code, manage_project_state и т.д.
