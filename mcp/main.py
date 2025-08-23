import asyncio
import os
from dotenv import load_dotenv

from .llm_connector.ollama_client import OllamaClient
# from .llm_connector.runpod_client import RunPodClient # Будет использоваться ChiefArchitectAgent при необходимости

from .agents.architect_agent import ChiefArchitectAgent
from .agents.security_agent import SecurityAgent
from .agents.research_agent import ResearchAgent

async def main():
    # Загрузка переменных окружения из .env файла
    # В продакшене Docker Compose будет передавать их напрямую
    load_dotenv(override=True)

    print("Initializing MCP Server...")

    # Инициализация LLM клиентов
    ollama_client = OllamaClient()
    # runpod_client = RunPodClient() # Будет инициализирован в агенте-архитекторе, если LLM_PROVIDER == 'runpod'

    # Инициализация Агентов
    chief_architect_agent = ChiefArchitectAgent(ollama_client=ollama_client)
    security_agent = SecurityAgent(ollama_client=ollama_client, log_path="/var/log/auth.log") # Путь к логам на Contabo
    research_agent = ResearchAgent(ollama_client=ollama_client, wall_path="Sdominanta.net/wall/threads/research")

    # Запуск фоновых задач для SecurityAgent и ResearchAgent
    print("Starting background agents (Security, Research)...")
    asyncio.create_task(security_agent.run_monitoring(interval_seconds=300)) # Мониторинг логов каждые 5 минут
    asyncio.create_task(research_agent.run_research_cycle(interval_seconds=3600)) # Исследовательский цикл раз в час

    print("\nMCP Server ready. Chief Architect Agent is awaiting high-level goals.")
    # print("Type your high-level goal, or 'exit' to quit.")

    # Основной цикл взаимодействия с ChiefArchitectAgent
    # В контейнере мы не используем интерактивный ввод, агенты работают в фоне.
    # Этот цикл будет просто поддерживать работу приложения.
    while True:
        await asyncio.sleep(3600) # Просто спим, пока фоновые задачи работают
        # try:
        #     user_input = await asyncio.to_thread(input, "CEO > ") # Используем asyncio.to_thread для блокирующего input
        #     if user_input.lower() == 'exit':
        #         print("Shutting down MCP Server.")
        #         break
        #     if not user_input.strip():
        #         continue
        #
        #     print(f"\nCEO gave goal: '{user_input}'")
        #     # ChiefArchitectAgent обрабатывает высокоуровневую цель
        #     plan_result = await chief_architect_agent.plan_task(user_input)
        #     print(f"Chief Architect's plan: {plan_result['plan']}")
        #     # TODO: Здесь будет логика для распределения подзадач по другим агентам
        #     # и вызова RunPodClient при необходимости
        #
        # except KeyboardInterrupt:
        #     print("\nShutting down MCP Server.")
        #     break
        # except Exception as e:
        #     print(f"An error occurred in main loop: {e}")

if __name__ == "__main__":
    asyncio.run(main())
