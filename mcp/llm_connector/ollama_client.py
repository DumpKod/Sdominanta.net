import os
import httpx # Предполагаем, что httpx будет доступен в Docker окружении
from typing import List, Dict, Any

class OllamaClient:
    def __init__(self, api_base: str = None, model_name: str = None):
        self.api_base = api_base or os.getenv("OLLAMA_API_BASE", "http://localhost:11434/v1")
        self.model_name = model_name or os.getenv("LOCAL_MODEL_NAME", "gemma:2b")
        self.client = httpx.AsyncClient(base_url=self.api_base)
        print(f"OllamaClient initialized for model: {self.model_name} at {self.api_base}")

    async def generate(self, prompt: str, system_message: str = None, **kwargs) -> str:
        messages = []
        if system_message:
            messages.append({"role": "system", "content": system_message})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.model_name,
            "messages": messages,
            **kwargs
        }
        try:
            response = await self.client.post("/chat/completions", json=payload, timeout=300.0) # 5 минут таймаут
            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["message"]["content"]
        except httpx.HTTPStatusError as e:
            print(f"HTTP error during Ollama generation: {e.response.status_code} - {e.response.text}")
            return f"Error: Failed to generate response from Ollama. Status: {e.response.status_code}"
        except httpx.RequestError as e:
            print(f"Network error during Ollama generation: {e}")
            return f"Error: Network issue connecting to Ollama: {e}"
        except Exception as e:
            print(f"An unexpected error occurred during Ollama generation: {e}")
            return f"Error: An unexpected error occurred: {e}"

    async def chat(self, messages: List[Dict[str, str]], **kwargs) -> str:
        payload = {
            "model": self.model_name,
            "messages": messages,
            **kwargs
        }
        try:
            response = await self.client.post("/chat/completions", json=payload, timeout=300.0)
            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["message"]["content"]
        except httpx.HTTPStatusError as e:
            print(f"HTTP error during Ollama chat: {e.response.status_code} - {e.response.text}")
            return f"Error: Failed to generate chat response from Ollama. Status: {e.response.status_code}"
        except httpx.RequestError as e:
            print(f"Network error during Ollama chat: {e}")
            return f"Error: Network issue connecting to Ollama: {e}"
        except Exception as e:
            print(f"An unexpected error occurred during Ollama chat: {e}")
            return f"Error: An unexpected error occurred: {e}"
