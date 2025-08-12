# 🚀 Sdominanta MCP Server Launcher

**Автоматический запуск MCP сервера для всех пользователей!**

## 🎯 Что это?

Sdominanta MCP Server - это автономный сервер Model Context Protocol для Cursor/Claude, который предоставляет доступ к:
- Контексту проекта (seed, schema, prompt)
- Валидации телеметрии
- Проверке метрик T_meas
- Верификации подписей в wall/threads

## 🚀 Быстрый запуск

### Вариант 1: Автоматический запуск (рекомендуется)

1. **Скачайте проект** или клонируйте репозиторий
2. **Запустите один из скриптов:**

#### Windows (Batch):
```cmd
start_mcp_server.bat
```

#### Windows (PowerShell):
```powershell
.\Start-McpServer.ps1
```

#### Linux/macOS:
```bash
chmod +x start_mcp_server.sh
./start_mcp_server.sh
```

### Вариант 2: Ручной запуск

1. **Установите зависимости:**
```bash
python -m pip install -r requirements.txt
```

2. **Запустите MCP сервер:**
```bash
python mcp_server.py --base "путь/к/проекту"
```

## ⚙️ Настройка для Cursor

### Автоматическая настройка

Скрипты автоматически создают конфигурацию MCP для Cursor.

### Ручная настройка

Создайте файл `C:\Users\<username>\.cursor\mcp.json`:

```json
{
  "mcpServers": {
    "sdominanta-mcp": {
      "command": "python",
      "args": [
        "путь\\к\\проекту\\mcp_server.py",
        "--base",
        "путь\\к\\проекту"
      ],
      "type": "stdio",
      "env": {
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8"
      }
    }
  }
}
```

## 🔧 Возможности скриптов

### PowerShell скрипт (`Start-McpServer.ps1`)

```powershell
# Установка зависимостей
.\Start-McpServer.ps1 -Install

# Тестирование MCP сервера
.\Start-McpServer.ps1 -Test

# Запуск с указанным путем
.\Start-McpServer.ps1 -BasePath "C:\path\to\project"

# Показать справку
.\Start-McpServer.ps1 -Help
```

### Batch скрипт (`start_mcp_server.bat`)

Простой запуск одним кликом - проверяет Python, зависимости и запускает сервер.

## 📋 Требования

- **Python 3.10+** (автоматически проверяется)
- **Зависимости** (автоматически устанавливаются)
- **Windows/Linux/macOS** (кроссплатформенность)

## 🛠️ Инструменты MCP

После запуска в Cursor будут доступны:

- `get_seed()` - контекст проекта
- `get_schema()` - схема телеметрии  
- `version_info()` - информация о версиях
- `prompt()` - стартовый промпт
- `validate_telemetry_tool()` - валидация телеметрии
- `validate_tmeas_tool()` - проверка метрик
- `verify_wall_signatures_tool()` - верификация подписей

## 🔍 Диагностика

### Проверка статуса

```powershell
.\Start-McpServer.ps1 -Test
```

### Логи

Скрипты выводят подробные логи с временными метками и цветовой индикацией.

### Частые проблемы

1. **Python не найден** - установите Python 3.10+
2. **Зависимости не установлены** - запустите с `-Install`
3. **Путь с символами** - используйте абсолютные пути
4. **Кодировка** - автоматически настраивается

## 🌟 Особенности

- ✅ **Автоматическая установка** зависимостей
- ✅ **Кроссплатформенность** (Windows, Linux, macOS)
- ✅ **Умная диагностика** проблем
- ✅ **Цветные логи** для удобства
- ✅ **Автоматическая настройка** Cursor
- ✅ **Проверка совместимости** Python

## 🚀 Запуск для всех!

Теперь любой пользователь может запустить MCP сервер одним кликом:

1. **Скачать проект**
2. **Запустить скрипт**
3. **Наслаждаться MCP!**

---

**Sdominanta.net** - MCP для всех! 🎉
