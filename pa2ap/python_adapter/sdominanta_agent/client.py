import asyncio
import websockets
import json
import uuid

class SdominantaAgent:
    def __init__(self, daemon_url="ws://127.0.0.1:9090"):
        self.daemon_url = daemon_url
        self.websocket = None
        self.peer_id = str(uuid.uuid4()) # Уникальный ID для этого агента
        self.message_handlers = {} # Для обработки входящих сообщений по топикам

    async def connect(self):
        try:
            self.websocket = await websockets.connect(self.daemon_url)
            print(f"Connected to Pa2ap Daemon at {self.daemon_url}")
            # Анонсируем свое присутствие в сети
            await self.announce_presence({"peerId": self.peer_id, "capabilities": ["wall", "research"]})
            # Запускаем фоновую задачу для прослушивания сообщений
            asyncio.create_task(self._listen_for_messages())
        except Exception as e:
            print(f"Failed to connect to Pa2ap Daemon: {e}")
            self.websocket = None

    async def disconnect(self):
        if self.websocket:
            await self.websocket.close()
            print("Disconnected from Pa2ap Daemon")
            self.websocket = None

    async def _send_message(self, message):
        if self.websocket:
            await self.websocket.send(json.dumps(message))
        else:
            print("WebSocket not connected. Message not sent.")

    async def _listen_for_messages(self):
        while self.websocket:
            try:
                message = await self.websocket.recv()
                msg = json.loads(message)
                #print(f"Received from daemon: {msg}")
                if msg.get('type') == 'message' and msg.get('topic') in self.message_handlers:
                    for handler in self.message_handlers[msg['topic']]:
                        await handler(msg['data'])
            except websockets.exceptions.ConnectionClosed:
                print("Pa2ap Daemon connection closed.")
                self.websocket = None
                break
            except Exception as e:
                print(f"Error listening for messages: {e}")

    async def publish(self, topic: str, data: dict):
        """Публикует данные в указанный топик."""
        await self._send_message({'type': 'publish', 'topic': topic, 'data': data})
        print(f"Published to topic '{topic}': {data}")

    async def subscribe(self, topic: str, handler):
        """Подписывается на топик и регистрирует обработчик сообщений."""
        if topic not in self.message_handlers:
            self.message_handlers[topic] = []
        self.message_handlers[topic].append(handler)
        await self._send_message({'type': 'subscribe', 'topic': topic})
        print(f"Subscribed to topic: {topic}")

    async def get_peers(self):
        """Запрашивает список известных пиров."""
        await self._send_message({'type': 'get_peers'})
        # В реальной реализации, ответ будет получен через _listen_for_messages
        # и передан обратно через Future или callback. Для MVP просто печатаем.
        print("Requested peer list from daemon.")

    async def announce_presence(self, data: dict):
        """Анонсирует присутствие агента в сети."""
        await self._send_message({'type': 'announce', 'peerId': self.peer_id, 'data': data})
        print(f"Announced presence with Peer ID: {self.peer_id}")

# Пример использования (для тестирования)
async def main_test():
    agent = SdominantaAgent()
    await agent.connect()

    if agent.websocket:
        # Пример обработчика для входящих сообщений
        async def wall_message_handler(data):
            print(f"HANDLED WALL MESSAGE: {data}")

        async def announce_message_handler(data):
            print(f"HANDLED ANNOUNCE MESSAGE: {data}")

        await agent.subscribe("sdom/wall", wall_message_handler)
        await agent.subscribe("sdom/agents/announce", announce_message_handler)

        await agent.publish("sdom/wall", {"hash": "abc", "content": "Hello world from Python!"})
        await agent.publish("sdom/agents/announce", {"peerId": "another-peer", "data": "I'm here too!"})

        await agent.get_peers()

        await asyncio.sleep(10) # Даем время для обмена сообщениями
        await agent.disconnect()

if __name__ == '__main__':
    # Для запуска `sdom-p2p.js` нужно установить 'ws': npm install ws
    # Запускать так:
    # 1. node Sdominanta.net/pa2ap/daemon/sdom-p2p.js
    # 2. python Sdominanta.net/pa2ap/python_adapter/sdominanta_agent/client.py
    # (или запустить main_test() асинхронно)
    try:
        asyncio.run(main_test())
    except KeyboardInterrupt:
        print("Test interrupted.")
