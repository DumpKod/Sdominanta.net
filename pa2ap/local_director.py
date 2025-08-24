import asyncio
import json
from nostr_sdk import Keys, Client, EventBuilder, Filter, HandleNotification, Timestamp
import ssl
import websockets
import httpx
from aioconsole import ainput

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
        await self._ws.close()

# --- Основной код Директора ---

async def run_director():
    # --- ВАШИ ДАННЫЕ ---
    SERVER_IP = "62.169.28.124"
    # Оставьте пустым для генерации нового ключа, или вставьте свой hex-ключ
    MY_PRIVATE_KEY = ""
    # --- КОНЕЦ ВАШИХ ДАННЫХ ---

    if MY_PRIVATE_KEY:
        keys = Keys.from_sk_hex(MY_PRIVATE_KEY)
    else:
        keys = Keys.generate()
        print(f"!!! SAVE THIS PRIVATE KEY: {keys.secret_key().to_hex()} !!!")
    
    print(f"Director Public Key: {keys.public_key().to_hex()}")

    ws_url = f"ws://{SERVER_IP}:9090"
    api_url = f"http://{SERVER_IP}:8787/wall/note"
    
    unsecure_ws = SdominantaUnsecureWebsocket(ws_url)
    await unsecure_ws.connect()

    print(f"\n--- Connected to Sdominanta Network at {ws_url} ---")

    await unsecure_ws.send(json.dumps(["REQ", "1", {"kinds": [1], "tags": {"#t": ["sdom/wall/general"]}}]))
    print("Subscribed to sdom/wall/general")
    await unsecure_ws.send(json.dumps(["REQ", "2", {"kinds": [4], "#p": [keys.public_key().to_hex()]}]))
    print(f"Subscribed to personal topic: {keys.public_key().to_hex()}")

    print("--- Waiting for messages... ---")

    async def listen_for_messages():
        while True:
            try:
                message = await unsecure_ws.recv()
                print(f"\n<<< Received message: {message}\n>>> ", end="")
            except websockets.ConnectionClosed:
                print("Connection closed.")
                break

    async def send_messages():
        while True:
            try:
                command = await ainput(">>> ")
                if command.strip() == "":
                    continue
                
                parts = command.split(" ", 2)
                if parts[0] == ".msg" and len(parts) == 3:
                    recipient_pubkey = parts[1]
                    content = parts[2]
                    
                    event = EventBuilder.encrypted_direct_msg(keys, recipient_pubkey, content).to_event(keys)
                    note_signed = json.loads(event.as_json())
                    
                    async with httpx.AsyncClient() as client:
                        response = await client.post(api_url, json=note_signed)
                        response.raise_for_status()
                        print(f"--- Direct message sent to {recipient_pubkey} ---")

                elif parts[0] == ".pub" and len(parts) == 2:
                    content = parts[1]
                    event = EventBuilder.new_text_note(content, []).to_event(keys)
                    note_signed = json.loads(event.as_json())
                    
                    async with httpx.AsyncClient() as client:
                        response = await client.post(api_url, json=note_signed)
                        response.raise_for_status()
                        print(f"--- Public note sent ---")
                
                elif command == ".exit":
                    break
                else:
                    print("--- Unknown command. Use .msg <pubkey> <message> or .pub <message> or .exit ---")
            except Exception as e:
                print(f"Error sending message: {e}")


    listen_task = asyncio.create_task(listen_for_messages())
    send_task = asyncio.create_task(send_messages())

    await send_task
    listen_task.cancel()
    await unsecure_ws.close()


if __name__ == "__main__":
    try:
        asyncio.run(run_director())
    except KeyboardInterrupt:
        print("\nExiting...")