import asyncio
import json
from nostr_sdk import Keys, EventBuilder, Tag, PublicKey, SecretKey
import websockets
import httpx
import ssl

class SdominantaAgent:
    def __init__(self, private_key: str = None):
        if private_key:
            sk = SecretKey.from_hex(private_key)
            self.keys = Keys(sk)
        else:
            self.keys = Keys.generate()
        
        self.public_key = self.keys.public_key().to_hex()
        self.ws = None

    async def connect(self, ws_url="ws://localhost:9090"):
        # Отключаем SSL для ws:// URI
        if ws_url.startswith("wss://"):
            ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
            self.ws = await websockets.connect(ws_url, ssl=ssl_context)
        else:
            self.ws = await websockets.connect(ws_url)
        print(f"Connected to {ws_url}")

    async def subscribe(self, topic, filters):
        if not self.ws:
            raise ConnectionError("WebSocket is not connected.")
        
        subscribe_message = json.dumps({
            "type": "REQ",
            "id": topic, # Use topic as subscription ID
            "filters": [filters] # Wrap filters in a list
        })
        await self.ws.send(subscribe_message)
        print(f"Subscribed with ID {topic} to {filters}")

    async def publish_event(self, event, api_url):
        # Создаем Nostr событие
        note_signed = json.loads(event.as_json())
        # print(f"Publishing event: {note_signed}")
        async with httpx.AsyncClient() as client:
            response = await client.post(api_url, json=note_signed)
            response.raise_for_status()
            # print(f"Published event: {response.json()}")

    async def listen(self, callback):
        if not self.ws:
            raise ConnectionError("WebSocket is not connected.")
        try:
            async for message in self.ws:
                # print(f"Received raw message: {message}")
                data = json.loads(message)
                if data[0] == "EVENT":
                    event_data = data[2]
                    # print(f"Decrypted event: {event_data}")
                    event_kind = event_data.get("kind")
                    event_content = event_data.get("content")
                    event_pubkey = event_data.get("pubkey")

                    if event_kind == 4: # Direct message
                        # print(f"Attempting to decrypt DM from {event_pubkey}")
                        try:
                            decrypted_content = nip04_encrypt(self.keys.secret_key(), PublicKey.from_hex(event_pubkey), event_content)
                            # print(f"Decrypted content: {decrypted_content}")
                            callback(f"Direct Message from {event_pubkey}: {decrypted_content}")
                        except Exception as e:
                            callback(f"Could not decrypt DM from {event_pubkey}: {e}")
                    elif event_kind == 1: # Public note
                        callback(f"Public Note from {event_pubkey}: {event_content}")
                    else:
                        callback(f"Unhandled event kind {event_kind} from {event_pubkey}: {event_content}")
                elif data[0] == "EOSE":
                    pass # End of Stored Events
                elif data[0] == "OK":
                    pass # Event Published
                elif data[0] == "NOTICE":
                    print(f"NOTICE: {data[1]}")
                else:
                    callback(f"Received unhandled message: {data}")
        except websockets.exceptions.ConnectionClosedOK:
            print("WebSocket connection closed gracefully.")
        except Exception as e:
            print(f"WebSocket error: {e}")
