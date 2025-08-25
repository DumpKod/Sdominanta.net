import asyncio
from pa2ap.agent import SdominantaAgent
from nostr_sdk import Keys, EventBuilder, Tag, nip04_encrypt, PublicKey, SecretKey
import json
from aioconsole import ainput
import ssl # Required for SdominantaUnsecureWebsocket
import websockets # Required for SdominantaUnsecureWebsocket

# Этот класс-заглушка нужен, потому что наш pa2ap_daemon не настоящий nostr-relay
# и не отвечает на запросы аутентификации, которые шлет nostr-sdk.
# Мы просто игнорируем эти сообщения.
class SdominantaUnsecureWebsocket:
    def __init__(self, uri):
        self._uri = uri
        self._ws = None

    async def connect(self):
        # Отключаем SSL для ws:// URI
        if self._uri.startswith("wss://"):
            ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
            self._ws = await websockets.connect(self._uri, ssl=ssl_context)
        else:
            self._ws = await websockets.connect(self._uri)

    async def send(self, message):
        if "AUTH" in message:
            print(f"Ignoring AUTH message: {message}")
            return
        await self._ws.send(message)

    async def recv(self):
        return await self._ws.recv()

    async def close(self):
        if self._ws:
            await self._ws.close()
            print("WebSocket connection closed.")

async def run_director():
    # --- ВАШИ ДАННЫЕ ---
    SERVER_IP = "62.169.28.124"
    # Оставьте пустым для генерации нового ключа, или вставьте свой hex-ключ
    MY_PRIVATE_KEY = "" 
    # --- КОНЕЦ ВАШИХ ДАННЫХ ---

    agent = SdominantaAgent(private_key=MY_PRIVATE_KEY)
    print(f"Director Public Key: {agent.public_key}")
    if not MY_PRIVATE_KEY:
        print(f"!!! SAVE THIS PRIVATE KEY: {agent.keys.secret_key().to_hex()} !!!")

    ws_url = f"ws://{SERVER_IP}:9090"
    api_url = f"http://{SERVER_IP}:8787/wall/note"
    
    await agent.connect(ws_url)

    print(f"\n--- Connected to Sdominanta Network at {ws_url} ---")

    # Подписка на публичные сообщения
    await agent.subscribe("sub_general", {"kinds": [1]})
    
    # Подписка на личные сообщения
    await agent.subscribe("sub_dm", {"kinds": [4], "#p": [agent.public_key]})

    print("--- Waiting for messages... ---")
    print("--- Commands: .msg <pubkey> <message> | .pub <message> | .exit ---")

    async def listen_for_messages():
        await agent.listen(lambda msg: print(f"\n<<< Received message: {msg}\n>>> ", end=""))

    listen_task = asyncio.create_task(listen_for_messages())

    while True:
        user_input = await ainput(">>> ")
        parts = user_input.split(maxsplit=2)

        if parts[0] == ".exit":
            break
        elif parts[0] == ".pub" and len(parts) == 2:
            content = parts[1]
            event = EventBuilder.text_note(content).to_event(agent.keys)
            await agent.publish_event(event, api_url)
            print(f"Public note sent: {content}")
        elif parts[0] == ".msg" and len(parts) == 3:
            recipient_pubkey_hex = parts[1]
            content = parts[2]
            
            # Правильный способ создать зашифрованное сообщение (Kind 4)
            recipient_pubkey = PublicKey.from_hex(recipient_pubkey_hex)
            encrypted_content = nip04_encrypt(agent.keys.secret_key(), recipient_pubkey, content)
            event = EventBuilder(4, encrypted_content, [Tag.parse(["p", recipient_pubkey_hex])]).to_event(agent.keys)

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