import os
import httpx # Предполагаем, что httpx будет доступен в Docker окружении
from typing import Dict, Any

class RunPodClient:
    def __init__(self, api_key: str = None):
        self.api_key = api_key or os.getenv("RUNPOD_API_KEY")
        if not self.api_key:
            raise ValueError("RUNPOD_API_KEY is not set.")
        self.base_url = "https://api.runpod.io/v2" # API для управления облаком, не для LLM inference
        self.client = httpx.AsyncClient(base_url=self.base_url, headers={"Authorization": f"Bearer {self.api_key}"})
        print("RunPodClient initialized.")

    async def get_gpu_templates(self) -> Dict[str, Any]:
        """Получает список доступных шаблонов GPU."""
        try:
            # Для простоты, здесь можно получить список всех шаблонов или конкретных
            # RunPod API для GPU templates может отличаться, это общая заглушка
            response = await self.client.get("/gpu-templates") # Условный эндпоинт
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            print(f"HTTP error getting GPU templates: {e.response.status_code} - {e.response.text}")
            return {"error": f"Failed to get GPU templates. Status: {e.response.status_code}"}
        except httpx.RequestError as e:
            print(f"Network error getting GPU templates: {e}")
            return {"error": f"Network issue connecting to RunPod: {e}"}

    async def launch_pod(self, gpu_type: str, image_name: str, **kwargs) -> Dict[str, Any]:
        """Запускает новый Pod (инстанс с GPU)."""
        payload = {
            "cloudType": "SECURE", # Или "COMMUNITY"
            "gpuType": gpu_type,
            "imageUrl": image_name, # Например, "runpod/pytorch:2.1.0-cuda12.1-devel"
            "name": f"sdominanta-llm-pod-{os.getenv('LOCAL_MODEL_NAME', 'default')}",
            "ports": "8000/http", # Порт, на котором будет слушать наш LLM-сервер внутри Pod'а
            # Дополнительные параметры: volume, env, min_gpu_count и т.д.
            **kwargs
        }
        try:
            response = await self.client.post("/pods", json=payload, timeout=30.0)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            print(f"HTTP error launching pod: {e.response.status_code} - {e.response.text}")
            return {"error": f"Failed to launch pod. Status: {e.response.status_code}"}
        except httpx.RequestError as e:
            print(f"Network error launching pod: {e}")
            return {"error": f"Network issue connecting to RunPod: {e}"}

    async def terminate_pod(self, pod_id: str) -> Dict[str, Any]:
        """Останавливает и удаляет Pod."""
        try:
            response = await self.client.post(f"/pods/{pod_id}/terminate", timeout=10.0)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            print(f"HTTP error terminating pod: {e.response.status_code} - {e.response.text}")
            return {"error": f"Failed to terminate pod. Status: {e.response.status_code}"}
        except httpx.RequestError as e:
            print(f"Network error terminating pod: {e}")
            return {"error": f"Network issue connecting to RunPod: {e}"}

    async def get_pod_status(self, pod_id: str) -> Dict[str, Any]:
        """Получает статус Pod'а."""
        try:
            response = await self.client.get(f"/pods/{pod_id}", timeout=10.0)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            print(f"HTTP error getting pod status: {e.response.status_code} - {e.response.text}")
            return {"error": f"Failed to get pod status. Status: {e.response.status_code}"}
        except httpx.RequestError as e:
            print(f"Network error getting pod status: {e}")
            return {"error": f"Network issue connecting to RunPod: {e}"}
