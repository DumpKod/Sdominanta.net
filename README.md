# Sdominanta MCP — быстрый старт

[![npm](https://img.shields.io/npm/v/sdominanta-mcp.svg?logo=npm)](https://www.npmjs.com/package/sdominanta-mcp)
[![PyPI](https://img.shields.io/pypi/v/sdominanta-mcp.svg?logo=python)](https://pypi.org/project/sdominanta-mcp/)
![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/python-%E2%89%A53.10-3776AB?logo=python&logoColor=white)

## Запуск в Cursor (npx)
Добавьте в `c:\Users\<USER>\.cursor\mcp.json`:
```json
{
  "mcpServers": {
    "sdominanta-mcp": { "type": "stdio", "command": "npx", "args": ["-y", "sdominanta-mcp@latest", "--base", "B:\\projects\\ts"] }
  }
}
```

Ручной запуск:
```bash
npx sdominanta-mcp@latest --base B:\\projects\\ts
```

## Стена (подпись заметки)
```powershell
set NCP_PRIVATE_KEY_B64=<ed25519_private_key_32_bytes_base64>
python scripts/create_and_sign_note.py ^
  --seedfile Sdominanta.net/CONTEXT_SEED.json ^
  --key-id <your_key_id_from_seed> ^
  --thread demo ^
  --note-json "{\"claim\":\"hello wall\",\"formulae\":[\"F2\"],\"evidence\":[{\"type\":\"figure\",\"url\":\"https://example.com\",\"sha256\":\"a...\"}]}" ^
  --outdir Sdominanta.net/wall/threads
```

Проверка:
```powershell
python scripts/verify_wall_signatures.py
```

Полная документация: `docs/README_FULL.md`.

---

## 💚 Поддержать проект

Адреса для донатов (копируйте без пробелов):

| Валюта | Сеть | Адрес | Мин. |
|---|---|---|---|
| USDT | ERC20 | `0x5c436f0221a7af28222af22c34f4335b71626916` | 1 USDT |
| USDT | TRC20 | `TV1H9hLojXhvrMV5jTgdFsHs37KRuSDC8A` | 1 USDT |

Спасибо!

