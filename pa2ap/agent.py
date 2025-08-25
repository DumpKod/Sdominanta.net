import asyncio
import json
# Изменяем импорты с nostr_sdk на pynostr
from pynostr.key import PrivateKey, PublicKey
from pynostr.event import Event, EventKind
from pynostr.encrypted_dm import EncryptedDirectMessage
import websockets
import httpx
import ssl

# Этот класс-заглушка больше не нужен, так как Pynostr имеет свои механизмы
# class SdominantaUnsecureWebsocket:
#     def __init__(self, uri):
#         self._uri = uri
#         self._ws = None
#     async def connect(self):
#         if self._uri.startswith("wss://"):
#             ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
#             ssl_context.check_hostname = False
#             ssl_context.verify_mode = ssl.CERT_NONE
#             self._ws = await websockets.connect(self._uri, ssl=ssl_context)
#         else:
#             self._ws = await websockets.connect(self._uri)
#     async def send(self, message):
#         if "AUTH" in message:
#             print(f"Ignoring AUTH message: {message}")
#             return
#         await self._ws.send(message)
#     async def recv(self):
#         return await self._ws.recv()
#     async def close(self):
#         if self._ws:
#             await self._ws.close()
#             print("WebSocket connection closed.")


class SdominantaAgent:
    def __init__(self, private_key: str = None):
        if private_key:
            self.private_key = PrivateKey.from_hex(private_key) # Используем метод from_hex Pynostr
        else:
            self.private_key = PrivateKey() # Генерируем новый приватный ключ
        
        # Убеждаемся, что public_key всегда в чистом HEX формате (64 символа)
        self.public_key = self.private_key.public_key.hex() 
        self.ws = None

    async def connect(self, ws_url="ws://localhost:9090"):
        # Теперь Pynostr работает с websockets напрямую, без нашей заглушки SSL
        self.ws = await websockets.connect(ws_url)
        print(f"Connected to {ws_url}")

    async def subscribe(self, sub_id: str, filters: dict):
        if not self.ws:
            raise ConnectionError("WebSocket is not connected.")
        
        subscribe_message = json.dumps(["REQ", sub_id, filters])
        await self.ws.send(subscribe_message)
        print(f"Subscribed with ID {sub_id} to {filters}")

    async def publish(self, event: Event):
        """Отправляет событие напрямую в WebSocket relay."""
        if not self.ws:
            raise ConnectionError("WebSocket is not connected.")
        event_json = event.to_json()
        await self.ws.send(event_json)

    async def publish_event(self, event: Event, api_url: str):
        # Event уже подписан до вызова этой функции
        note_signed = event.to_dict()
        async with httpx.AsyncClient() as client:
            response = await client.post(api_url, json=note_signed)
            response.raise_for_status()

    async def listen(self, callback):
        if not self.ws:
            raise ConnectionError("WebSocket is not connected.")
        try:
            async for message in self.ws:
                data = json.loads(message)
                if data[0] == "EVENT":
                    event_data = data[2]
                    event_kind = event_data.get("kind")
                    event_content = event_data.get("content")
                    event_pubkey = event_data.get("pubkey")

                    if event_kind == EventKind.ENCRYPTED_DIRECT_MESSAGE: # Kind 4
                        try:
                            # Дешифруем сообщение с помощью PrivateKey
                            decrypted_content = self.private_key.decrypt_message(
                                encoded_message=event_content, public_key_hex=event_pubkey
                            )
                            callback(f"Direct Message from {event_pubkey}: {decrypted_content}")
                        except Exception as e:
                            callback(f"Could not decrypt DM from {event_pubkey}: {e}")
                    elif event_kind == EventKind.TEXT_NOTE: # Kind 1
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

    async def close(self):
        if self.ws:
            await self.ws.close()
            print("WebSocket connection closed.")
