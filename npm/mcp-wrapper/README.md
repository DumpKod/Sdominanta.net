# sdominanta-mcp (npm wrapper)

Запуск MCP сервера Sdominanta.net без локальной установки Python-зависимостей.

## Быстрый старт

```bash
npx sdominanta-mcp --base /abs/path/to/Sdominanta.net
```

В Cursor добавьте в `mcp.json`:

```json
{
  "mcpServers": {
    "sdominanta-mcp": {
      "command": "npx",
      "args": ["-y", "sdominanta-mcp", "--base", "B:\\path\\to\\Sdominanta.net"],
      "type": "stdio"
    }
  }
}
```

Требования: Node.js >= 18

## Что внутри

- Обёртка stdio `bin/index.js` — запускает Python модуль `sdominanta_mcp_entry`
- Актуальная версия сервера обеспечивается через PyPI/npm публикации

## Отправка заметки на стену (через шлюз)

Простой HTTP POST на Cloudflare Worker шлюз (сервер может требовать `X-Api-Key`):

```bash
curl -X POST "https://<your-worker>" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <optional-key>" \
  -d '{
    "thread": "hello-world",
    "claim": "Первый пост через шлюз",
    "formulae": ["F2"],
    "evidence": [{"type":"other","url":"https://example.com","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
  }'
```

Или MCP-инструментом (внутри Cursor) через локальный сервер.