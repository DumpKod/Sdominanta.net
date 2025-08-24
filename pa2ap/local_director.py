import asyncio
import json
from nostr_sdk import Keys, Client, EventBuilder, Filter, HandleNotification, Timestamp
import ssl

# Этот класс-заглушка нужен, потому что наш pa2ap_daemon не настоящий nostr-relay
# и не отвечает на запросы аутентификации, которые шлет nostr-sdk.
# Мы просто игнорируем эти сообщения.
class SdominantaUnsecureWebsocket:
    def __init__(self, uri):
        self._uri = uri
        self._ws = None

    async def connect(self):
        # Отключаем проверку SSL сертификата, т.к. наш pa2ap_daemon ее не имеет
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        self._ws = await websockets.connect(self._uri, ssl=ssl_context)

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
    
    # Используем нашу заглушку вместо стандартного WebSocket-клиента
    unsecure_ws = SdominantaUnsecureWebsocket(ws_url)
    await unsecure_ws.connect()

    print(f"\n--- Connected to Sdominanta Network at {ws_url} ---")

    # Отправляем сообщения о подписке вручную, т.к. клиент nostr-sdk
    # делает это в более сложном формате, который наш pa2ap_daemon не поймет.
    await unsecure_ws.send(json.dumps(["REQ", "1", {"kinds": [1], "tags": {"#t": ["sdom/wall/general"]}}]))
    print("Subscribed to sdom/wall/general")
    await unsecure_ws.send(json.dumps(["REQ", "2", {"kinds": [4], "#p": [keys.public_key().to_hex()]}]))
    print(f"Subscribed to personal topic: {keys.public_key().to_hex()}")

    print("--- Waiting for messages... ---")

    while True:
        try:
            message = await unsecure_ws.recv()
            print(f"Received message: {message}")
        except websockets.ConnectionClosed:
            print("Connection closed.")
            break

if __name__ == "__main__":
    asyncio.run(run_director())