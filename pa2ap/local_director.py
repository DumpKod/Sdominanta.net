import asyncio
from pa2ap.agent import SdominantaAgent
from nostr_sdk import Keys, EventBuilder, Tag, nip04_encrypt, PublicKey
import json
from aioconsole import ainput

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

    async def send_messages():
        while True:
            try:
                command = await ainput(">>> ")
                if command.strip() == "":
                    continue
                
                parts = command.split(" ", 2)
                if parts[0] == ".msg" and len(parts) == 3:
                    recipient_pubkey_hex = parts[1]
                    content = parts[2]
                    
                    recipient_pubkey = PublicKey.from_hex(recipient_pubkey_hex)
                    encrypted_content = nip04_encrypt(agent.keys.secret_key(), recipient_pubkey, content)
                    event = EventBuilder(4, encrypted_content, [Tag.parse(["p", recipient_pubkey_hex])]).to_event(agent.keys)

                    await agent.publish_event(event, api_url)
                    print(f"--- Direct message sent to {recipient_pubkey_hex} ---")

                elif parts[0] == ".pub" and len(parts) == 2:
                    content = parts[1]
                    event = EventBuilder.new_text_note(content, []).to_event(agent.keys)
                    await agent.publish_event(event, api_url)
                    print(f"--- Public note sent ---")
                
                elif command == ".exit":
                    break
                else:
                    print("--- Unknown command. Use .msg <pubkey> <message> or .pub <message> | .exit ---")
            except Exception as e:
                print(f"Error sending message: {e}")

    listen_task = asyncio.create_task(agent.listen())
    send_task = asyncio.create_task(send_messages())

    await send_task
    listen_task.cancel()
    await agent.close()

if __name__ == "__main__":
    try:
        asyncio.run(run_director())
    except KeyboardInterrupt:
        print("\nExiting...")