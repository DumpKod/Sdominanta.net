import asyncio
# Изменяем импорты с nostr_sdk на pynostr
from pynostr.key import PrivateKey, PublicKey
from pynostr.event import Event, EventKind
from pynostr.encrypted_dm import EncryptedDirectMessage
import json
from aioconsole import ainput
import websockets # Pynostr использует websockets напрямую
import httpx


# Заглушка SdominantaUnsecureWebsocket больше не нужна
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


# --- Основной код Директора ---
from pa2ap.agent import SdominantaAgent # Импортируем наш агент

async def run_director():
    # --- ВАШИ ДАННЫЕ ---
    SERVER_IP = "62.169.28.124"
    # Оставьте пустым для генерации нового ключа, или вставьте свой hex-ключ
    MY_PRIVATE_KEY = "" 
    # --- КОНЕЦ ВАШИХ ДАННЫХ ---

    agent = SdominantaAgent(private_key=MY_PRIVATE_KEY)
    print(f"Director Public Key: {agent.public_key}")
    if not MY_PRIVATE_KEY:
        print(f"!!! SAVE THIS PRIVATE KEY: {agent.private_key.hex()} !!!") # Используем agent.private_key.hex()

    ws_url = f"ws://{SERVER_IP}:9090"
    api_url = f"http://{SERVER_IP}:8787/wall/note"
    
    await agent.connect(ws_url)

    print(f"\n--- Connected to Sdominanta Network at {ws_url} ---")

    # Подписка на публичные сообщения
    await agent.subscribe("sub_general", {"kinds": [EventKind.TEXT_NOTE]})
    
    # Подписка на личные сообщения
    await agent.subscribe("sub_dm", {"kinds": [EventKind.ENCRYPTED_DIRECT_MESSAGE], "#p": [agent.public_key]})

    print("--- Waiting for messages... ---")
    print("--- Commands: .msg <pubkey> <message> | .pub <message> | .exit ---")

    async def listen_for_messages():
        await agent.listen(lambda msg: print(f"\n<<< Received message: {msg}\n>>> ", end=""))

    listen_task = asyncio.create_task(listen_for_messages())

    while True:
        user_input = await ainput(">>> ")
        
        if not user_input.strip(): # Добавляем проверку на пустой ввод
            continue

        parts = user_input.split(maxsplit=2)

        if parts[0] == ".exit":
            break
        elif parts[0] == ".pub" and len(parts) == 2:
            content = parts[1]
            # Создание и подпись Kind 1 события
            event = Event(
                content=content,
                pubkey=agent.public_key,
                kind=EventKind.TEXT_NOTE,
                tags=[]
            )
            event.sign(agent.private_key.hex())
            await agent.publish_event(event, api_url)
            print(f"Public note sent: {content}")
        elif parts[0] == ".msg" and len(parts) == 3:
            recipient_pubkey_hex = parts[1]
            content = parts[2]
            
            # Убеждаемся, что recipient_pubkey_hex имеет правильный формат (чистый HEX, 64 символа)
            if len(recipient_pubkey_hex) != 64 or not all(c in "0123456789abcdefABCDEF" for c in recipient_pubkey_hex):
                print("Error: Recipient public key must be a 64-character hexadecimal string.")
                continue

            # Создание, шифрование и подпись Kind 4 события
            dm = EncryptedDirectMessage(
                cleartext_content=content,
                recipient_pubkey=recipient_pubkey_hex
            )
            dm.encrypt(agent.private_key.hex())
            event = dm.to_event()
            event.sign(agent.private_key.hex())

            await agent.publish_event(event, api_url)
            print(f"Direct message sent to {recipient_pubkey_hex}")
        else:
            print("Unknown command or incorrect format.")

    listen_task.cancel()
    await agent.close()
    print("\nExiting...")

if __name__ == "__main__":
    try:
        asyncio.run(run_director())
    except KeyboardInterrupt:
        print("Exiting gracefully.")