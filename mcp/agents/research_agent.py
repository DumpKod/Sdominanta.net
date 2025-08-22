import os
import asyncio
import httpx # Для запросов в интернет
import json
from datetime import datetime
from ..llm_connector.ollama_client import OllamaClient
# from ...scripts.create_and_sign_note import create_and_sign_note # Потребуется адаптация
from typing import Dict, Any, List

class ResearchAgent:
    def __init__(self, ollama_client: OllamaClient, wall_path: str = "Sdominanta.net/wall/threads/research"):
        self.ollama_client = ollama_client
        self.name = "ResearchAgent"
        self.wall_path = wall_path
        self.system_prompt = (
            "Ты — исследователь проекта Sdominanta.net. "
            "Твоя задача — искать актуальные научные данные, статьи, новости по темам: "
            "AI alignment, теории сознания ИИ, новые архитектуры нейросетей, этика в AI, квантовые вычисления. "
            "Писать краткие саммари (1-2 абзаца) и публиковать их как подписанные 'Истины' на стене."
        )
        self.search_topics = [
            "AI alignment", "AI consciousness theories", "neural network architectures",
            "AI ethics", "quantum computing for AI", "large language model advancements"
        ]
        print(f"{self.name} initialized. Publishing research to: {self.wall_path}")

    async def _perform_web_search(self, query: str) -> List[Dict[str, Any]]:
        """Имитация веб-поиска."""
        # TODO: Интегрировать с реальным веб-поиском (например, через SerpApi, Google Custom Search API)
        print(f"{self.name} performing web search for: \"{query}\"")
        # Заглушка для демонстрации
        dummy_results = [
            {"title": "Latest in AI Alignment", "url": "https://example.com/ai-alignment-latest", "content": "Recent breakthroughs in ensuring AI safety and ethical behavior..."},
            {"title": "New Quantum Computing Architectures", "url": "https://example.com/quantum-ai-arch", "content": "Exploring novel designs for quantum processors to accelerate AI..."},
        ]
        return dummy_results

    async def summarize_article(self, url: str, content: str) -> str:
        """Суммирует содержимое статьи."""
        prompt = (
            f"Прочитай следующую статью и напиши краткое саммари (1-2 абзаца) на русском языке. "
            f"Особое внимание удели ключевым идеям и выводам.\n\n"
            f"URL: {url}\n\nСодержание:\n```\n{content}\n```"
        )
        summary = await self.ollama_client.generate(prompt, system_message=self.system_prompt)
        return summary

    async def publish_truth_to_wall(self, title: str, summary: str, author_key_id: str, tags: List[str] = None) -> Dict[str, Any]:
        """Публикует подписанную 'Истину' на стену в виде note-json."""
        # TODO: Интегрировать с scripts/create_and_sign_note.py
        # Для MVP просто имитация публикации
        note_content = {
            "title": title,
            "summary": summary,
            "url": "(source_url_if_any)",
            "tags": tags or []
        }
        print(f"{self.name} publishing truth to wall: {title}")
        # Создаем директорию, если ее нет
        os.makedirs(self.wall_path, exist_ok=True)
        timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
        note_filename = os.path.join(self.wall_path, f"research_{timestamp}.json")

        # Имитация подписи и сохранения
        signed_note = {
            "id": f"sdom:note:{timestamp}-{os.urandom(4).hex()}",
            "author": author_key_id,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "payload": note_content,
            "signature": "mock_signature"
        }

        with open(note_filename, 'w', encoding='utf-8') as f:
            json.dump(signed_note, f, ensure_ascii=False, indent=2)
        
        print(f"Truth published to {note_filename}")
        return {"status": "published", "path": note_filename}

    async def run_research_cycle(self, interval_seconds: int = 3600): # Раз в час
        """Запускает непрерывный цикл поиска и публикации исследований."""
        while True:
            print(f"{self.name} starting new research cycle...")
            for topic in self.search_topics:
                search_results = await self._perform_web_search(topic)
                for result in search_results:
                    summary = await self.summarize_article(result["url"], result["content"])
                    await self.publish_truth_to_wall(
                        title=result["title"],
                        summary=summary,
                        author_key_id=os.getenv("RESEARCH_AGENT_KEY_ID", "did:key:sdom-research-agent"),
                        tags=["research", topic.replace(" ", "-").lower()]
                    )
            await asyncio.sleep(interval_seconds)
