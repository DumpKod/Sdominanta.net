# Sdominanta MCP Server

Автономный MCP‑сервер для Cursor/Claude. Работает через stdio, не требует запусков «вручную». Достаточно прописать его в настройках клиента — и он будет доступен как инструмент.

Что умеет
- seed/schema/prompt/version: доступ к контексту и контроль версий артефактов
- validate_telemetry: проверка событий по `TELEMETRY_SCHEMA.json`
- validate_tmeas: проверки метрик `T_meas`
- verify_wall_signatures: проверка подписей в `wall/threads` по ключам из `CONTEXT_SEED.json`

## Быстрый старт (без установки, как у «остальных MCP»)

Рекомендуемый способ — запуск через пакетный раннер, чтобы у пользователя «не было ничего локально» руками:

### Вариант A: pipx run (Python пакет из PyPI)

1) Требуется Python 3.10+ и pipx. Установка pipx:
```powershell
python -m pip install --upgrade pipx
python -m pipx ensurepath
```

2) Cursor → файл `c:\Users\<user>\.cursor\mcp.json`:
```json
{
  "mcpServers": {
    "sdominanta-mcp": {
      "command": "pipx",
      "args": [
        "run", "--spec", "sdominanta-mcp",
        "sdominanta-mcp", "--base", "B:\\path\\to\\Sdominanta.net"
      ],
      "type": "stdio"
    }
  }
}
```

– pipx сам подтянет/обновит пакет с PyPI, запуск — без ручной установки в системе.

### Вариант B: локальный CLI (pipx install)

```powershell
pipx install sdominanta-mcp
```

`mcp.json`:
```json
{
  "mcpServers": {
    "sdominanta-mcp": {
      "command": "sdominanta-mcp",
      "args": ["--base", "B:\\path\\to\\Sdominanta.net"],
      "type": "stdio"
    }
  }
}
```

### Вариант C: локальный venv (разработчик)

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -e .
```

`mcp.json`:
```json
{
  "mcpServers": {
    "sdominanta-mcp": {
      "command": "B:\\path\\to\\Sdominanta.net\\.venv\\Scripts\\sdominanta-mcp.exe",
      "args": ["--base", "B:\\path\\to\\Sdominanta.net"],
      "type": "stdio"
    }
  }
}
```

Примечания
- В Windows в JSON экранируйте обратные слэши: `\\`.
- `--base` — абсолютный путь к корню репозитория (где лежат `CONTEXT_SEED.json` и `TELEMETRY_SCHEMA.json`).
- Для безопасной кодировки можно добавить окружение:
```json
"env": { "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8" }
```

## Инструменты (API)

- get_seed(): вернуть JSON из `CONTEXT_SEED.json`.
- get_schema(): вернуть JSON‑схему из `TELEMETRY_SCHEMA.json`.
- version_info(): пути и SHA‑256 основных файлов.
- prompt(): стартовый промпт (prelude + нотация + список файлов из seed).
- validate_telemetry_tool(events_json?: str, events_path?: str):
  - Вход: строка JSON массива событий или путь к файлу (по умолчанию `telemetry_samples.json`).
  - Выход: `{ ok: bool, count: number, errors: [{index, error}] }`.
- validate_tmeas_tool(metrics_json?: str, metrics_path?: str, write_report?: bool=false):
  - Вход: строка JSON с метриками или путь (по умолчанию `metrics.json`), опция записи `tmeas_report.txt`.
  - Выход: `{ ok: bool, report: string }`.
- verify_wall_signatures_tool(threads_dir?: str):
  - Проверка подписей в каталоге `wall/threads` по публичным ключам из `CONTEXT_SEED.json`.
  - Выход: `{ ok: bool, verified: number, errors: string[] }`.

## Обновления и публикация

- Релиз: GitHub Actions `release.yml` (создаёт тег `sdominanta-mcp-vX.Y.Z`).
- Публикация на PyPI: `publish-pypi.yml` по тэгу (нужен секрет `PYPI_TOKEN`).
- Пользователи в Cursor при варианте «pipx run» получают актуальную версию без ручной установки.

## Типовые проблемы

- Путь с символами (например, `🜄`) — используйте абсолютные пути и экранирование в JSON.
- Кодировка Windows — добавьте `PYTHONUTF8=1` и `PYTHONIOENCODING=utf-8` в `env`.
- `verify_wall_signatures`: требуется секция `public_keys` в `CONTEXT_SEED.json`.

