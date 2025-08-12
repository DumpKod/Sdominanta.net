# 🚀 sdominanta-mcp

**Автономный MCP сервер для Cursor/Claude с валидацией телеметрии, проверкой метрик и верификацией подписей**

## 📦 Установка

### Глобальная установка:
```bash
npm install -g sdominanta-mcp
```

### Использование через npx (рекомендуется):
```bash
npx sdominanta-mcp --base /path/to/project
```

## ⚙️ Настройка для Cursor

### Вариант 1: npx (автоматические обновления)
```json
{
  "mcpServers": {
    "sdominanta-mcp": {
      "command": "npx",
      "args": ["-y", "sdominanta-mcp", "--base", "B:\\projects\\🜄Sdominanta.net\\Sdominanta.net"],
      "type": "stdio"
    }
  }
}
```

### Вариант 2: глобальная установка
```json
{
  "mcpServers": {
    "sdominanta-mcp": {
      "command": "sdominanta-mcp",
      "args": ["--base", "B:\\projects\\🜄Sdominanta.net\\Sdominanta.net"],
      "type": "stdio"
    }
  }
}
```

## 🛠️ Доступные инструменты

- `get_seed()` - контекст проекта
- `get_schema()` - схема телеметрии
- `version_info()` - информация о версиях
- `prompt()` - стартовый промпт
- `validate_telemetry_tool()` - валидация телеметрии
- `validate_tmeas_tool()` - проверка метрик
- `verify_wall_signatures_tool()` - верификация подписей

## 🌟 Преимущества

- ✅ **Без локального venv** - автоматическая установка зависимостей
- ✅ **Глобальная доступность** - работает из любой директории
- ✅ **Автообновления** - npx всегда берет последнюю версию
- ✅ **Кроссплатформенность** - Windows, Linux, macOS
- ✅ **Безопасность** - не нужно клонировать весь репозиторий

## 🔗 Ссылки

- **npm:** https://www.npmjs.com/package/sdominanta-mcp
- **GitHub:** https://github.com/DumpKod/Sdominanta.net
- **Документация:** [MCP_LAUNCHER_README.md](../../MCP_LAUNCHER_README.md)

---

**Sdominanta.net** - MCP для всех! 🎉
