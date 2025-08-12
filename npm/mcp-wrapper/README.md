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
