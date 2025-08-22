import os
import json
import asyncio
from typing import Dict, Any, List, Optional
from datetime import datetime

class AgentRegistry:
    def __init__(self, registry_file: str = "agent_registry.json"):
        self.registry_file = registry_file
        self.agents: Dict[str, Dict[str, Any]] = self._load_registry()
        print(f"AgentRegistry initialized. Loaded {len(self.agents)} agents.")

    def _load_registry(self) -> Dict[str, Dict[str, Any]]:
        if os.path.exists(self.registry_file):
            with open(self.registry_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {}

    def _save_registry(self) -> None:
        with open(self.registry_file, 'w', encoding='utf-8') as f:
            json.dump(self.agents, f, ensure_ascii=False, indent=2)

    async def register_agent(self, agent_id: str, address: str, capabilities: List[str]) -> Dict[str, Any]:
        """
        Регистрирует агента в реестре.
        """
        self.agents[agent_id] = {
            "id": agent_id,
            "address": address,
            "capabilities": capabilities,
            "status": "active",
            "last_heartbeat": datetime.utcnow().isoformat() + "Z"
        }
        self._save_registry()
        print(f"AgentRegistry: Агент {agent_id} зарегистрирован по адресу {address}.")
        return {"status": "registered", "agent_id": agent_id}

    async def unregister_agent(self, agent_id: str) -> Dict[str, Any]:
        """
        Удаляет агента из реестра.
        """
        if agent_id in self.agents:
            del self.agents[agent_id]
            self._save_registry()
            print(f"AgentRegistry: Агент {agent_id} удален из реестра.")
            return {"status": "unregistered", "agent_id": agent_id}
        return {"status": "error", "message": "Agent not found"}

    async def send_heartbeat(self, agent_id: str) -> Dict[str, Any]:
        """
        Обновляет время последнего "пульса" для агента.
        """
        if agent_id in self.agents:
            self.agents[agent_id]["last_heartbeat"] = datetime.utcnow().isoformat() + "Z"
            self.agents[agent_id]["status"] = "active"
            self._save_registry()
            # print(f"AgentRegistry: Пульс для агента {agent_id} обновлен.")
            return {"status": "heartbeat_updated", "agent_id": agent_id}
        return {"status": "error", "message": "Agent not found"}

    async def get_agent_info(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """
        Возвращает информацию о конкретном агенте.
        """
        return self.agents.get(agent_id)

    async def get_all_registered_agents(self, capability: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Возвращает список всех зарегистрированных агентов, опционально фильтруя по возможностям.
        """
        if capability:
            return [agent for agent in self.agents.values() if capability in agent.get("capabilities", [])]
        return list(self.agents.values())

    async def cleanup_inactive_agents(self, timeout_seconds: int = 300):
        """
        Удаляет неактивных агентов (без пульса в течение timeout_seconds).
        """
        current_time = datetime.utcnow()
        to_remove = []
        for agent_id, agent_info in self.agents.items():
            last_heartbeat_str = agent_info.get("last_heartbeat")
            if last_heartbeat_str:
                last_heartbeat = datetime.fromisoformat(last_heartbeat_str.replace("Z", "+00:00"))
                if (current_time - last_heartbeat).total_seconds() > timeout_seconds:
                    to_remove.append(agent_id)
        
        for agent_id in to_remove:
            print(f"AgentRegistry: Удаление неактивного агента {agent_id}.")
            del self.agents[agent_id]
        
        if to_remove:
            self._save_registry()

# Класс ServerOps может быть оберткой над AgentRegistry
class ServerOps:
    def __init__(self, registry_file: str = "Sdominanta.net/agent_registry.json"):
        self.agent_registry = AgentRegistry(registry_file)
        print("ServerOps initialized.")

    async def run_registry_cleanup_loop(self, interval_seconds: int = 60, agent_timeout_seconds: int = 300):
        """
        Запускает фоновый цикл очистки неактивных агентов из реестра.
        """
        while True:
            await self.agent_registry.cleanup_inactive_agents(agent_timeout_seconds)
            await asyncio.sleep(interval_seconds)

    # Дополнительные методы для управления сервером (например, перезапуск агентов, получение метрик и т.д.)
