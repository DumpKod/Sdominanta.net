import asyncio
import json
from nostr_sdk import Keys, EventBuilder
import websockets
import httpx
import ssl

class SdominantaAgent:
    def __init__(self, private_key: str = None):
        if private_key:
            self.keys = Keys.from_sk_hex(private_key)
        else:
            self.keys = Keys.generate()
        
        self.public_key = self.keys.public_key().to_hex()
        self.ws = None

    async def connect(self, ws_url="ws://localhost:9090"):
        if ws_url.startswith("wss://"):
            ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
            self.ws = await websockets.connect(ws_url, ssl=ssl_context)
        else:
            self.ws = await websockets.connect(ws_url)
        print(f"Connected to {ws_url}")

    async def subscribe(self, sub_id: str, filter_json: dict):
        if not self.ws:
            raise ConnectionError("WebSocket is not connected.")
        
        subscribe_message = json.dumps(["REQ", sub_id, filter_json])
        await self.ws.send(subscribe_message)
        print(f"Subscribed with ID {sub_id} to {filter_json}")

    async def listen(self):
        if not self.ws:
            raise ConnectionError("WebSocket is not connected.")
        
        while True:
            try:
                message = await self.ws.recv()
                print(f"\n<<< Received message: {message}\n>>> ", end="")
            except websockets.ConnectionClosed:
                print("Connection closed.")
                break

    async def publish_event(self, event, api_url):
        note_signed = json.loads(event.as_json())
        async with httpx.AsyncClient() as client:
            response = await client.post(api_url, json=note_signed)
            response.raise_for_status()
            return response.json()

    async def close(self):
        if self.ws:
            await self.ws.close()
            print("WebSocket connection closed.")
