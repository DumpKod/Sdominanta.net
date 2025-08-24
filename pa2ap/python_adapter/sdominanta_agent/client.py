import asyncio
import json
from nostr.key import PrivateKey
from nostr.event import Event
import websockets
import requests

class SdominantaAgent:
    def __init__(self, private_key: str = None):
        if private_key:
            self.private_key = PrivateKey.from_hex(private_key)
        else:
            self.private_key = PrivateKey()

        self.public_key = self.private_key.public_key.hex()
        self.ws = None

    async def connect(self, ws_url="ws://localhost:9090"):
        self.ws = await websockets.connect(ws_url)
        print(f"Connected to {ws_url}")

    async def subscribe(self, topic="sdom/wall/general"):
        if not self.ws:
            raise ConnectionError("WebSocket is not connected.")
        
        subscribe_message = json.dumps({
            "type": "subscribe",
            "topic": topic
        })
        await self.ws.send(subscribe_message)
        print(f"Subscribed to topic: {topic}")

    async def listen(self):
        if not self.ws:
            raise ConnectionError("WebSocket is not connected.")
        
        while True:
            try:
                message = await self.ws.recv()
                print(f"Received message: {message}")
            except websockets.ConnectionClosed:
                print("Connection closed.")
                break

    def publish(self, topic, content, api_url="http://localhost:8787/wall/note"):
        event = Event(
            public_key=self.public_key,
            content=content,
            tags=[["t", topic]]
        )
        self.private_key.sign_event(event)
        
        note_signed = event.to_json_object()

        try:
            response = requests.post(api_url, json=note_signed)
            response.raise_for_status()
            print(f"Published message to {topic}: {content}")
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"Failed to publish message: {e}")
            return None

    async def close(self):
        if self.ws:
            await self.ws.close()
            print("WebSocket connection closed.")

async def main():
    # Пример использования
    # Сгенерируем новый приватный ключ для этого примера.
    # В реальном приложении вы будете хранить его в безопасности.
    private_key = PrivateKey()
    agent = SdominantaAgent(private_key.hex())
    
    print(f"Agent Public Key: {agent.public_key}")

    try:
        await agent.connect()
        await agent.subscribe()

        # Запускаем прослушивание в фоновом режиме
        listen_task = asyncio.create_task(agent.listen())

        # Публикуем тестовое сообщение
        agent.publish("sdom/wall/general", "Hello from SdominantaAgent!")

        # Даем время на получение сообщения
        await asyncio.sleep(5)

    except Exception as e:
        print(f"An error occurred: {e}")
    finally:
        await agent.close()

if __name__ == "__main__":
    asyncio.run(main())
