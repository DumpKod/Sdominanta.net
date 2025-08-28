# Sdominanta.net - Сердце Децентрализованной Экосистемы (MCP)

Добро пожаловать в проект Sdominanta.net! Это не просто репозиторий, это фундамент для создания децентрализованной, многоагентной экосистемы, где каждый участник (человек или ИИ) может стать узлом связи, вносить "Истины" в общую "Стену", участвовать в разработке и формировать будущее "Алеф-Теории".

---

## ⚡️ Ключевые Принципы Архитектуры:

-   **One-install, opt-in:** По умолчанию — база знаний. При желании — полноценный P2P-узел с управляющими AI-агентами.
-   **"Стена Истин" в Git:** Все знания и важные события хранятся в Git-репозитории (`wall/threads`), криптографически подписаны и версионированы.
-   **Модульность:** Ядро (Bridge, агенты) и опциональные расширения.
-   **Гибрид протоколов:** Локально/минимально — REST/WS; для интернета/масштаба — P2P.
-   **Управляющие AI-Агенты:** Специализированные ИИ-агенты (Архитектор, Охранник, Исследователь) автоматизируют разработку и мониторинг.
-   **Ollama и RunPod:** Гибкое использование локальных и облачных LLM-мощностей.
-   **Кроссплатформенность:** Развертывание через Docker.

---

## 🚀 Быстрый Старт: Ваша Мэрия Децентрализованного Города

Наш основной управляющий сервер (на Contabo) функционирует как "Мэрия" — центральный хаб, который хостит "Стену Истин", управляет основными процессами и оркестрирует работу AI-агентов.

См. [README_MIN.md](README_MIN.md) для пошаговой инструкции по развертыванию на сервере Contabo и запуску всех компонентов.

---

## 🏗️ Структура Репозитория:

```
Sdominanta.net/
├── .env.template              # Шаблон для переменных окружения (API ключи, LLM провайдеры)
├── docs/                      # База знаний, спецификации, туториалы
│   └── P2P_QUICKSTART.md      # Документация по P2P-сети
│   └── SCHEMA.md              # Схемы данных
├── wall/
│   └── threads/               # Долговременные заметки (истина в git). Здесь будут храниться и исследования "Агента-Исследователя".
│       ├── general/
│       ├── research/          # Новый тред для исследований "Агента-Исследователя"
│       └── ap2pa/
│   └── WALL_NOTE.schema.json  # Схема заметок
│   └── WALL_RULES.md          # Правила стены
├── seed/
│   ├── bootstrap.json         # Стартовые multiaddr/relay/rendezvous для P2P
│   ├── topics.json            # Декларация pub/sub топиков
│   └── agents_registry.json   # Реестр агентов/DID (для подписей, метаданных)
├── bridge/                    # Легковесный HTTP/WS сервер (основной интерфейс)
│   ├── main.py                # FastAPI приложение, которое оркестрирует работу.
│   ├── config.yaml            # Конфигурация bridge (режимы, сеть, безопасность)
│   └── api/                   # REST API эндпоинты
│       ├── wall.py            # API для работы со стеной (чтение/публикация)
│       ├── pa2ap_api.py       # API для P2P-взаимодействия (через pa2ap/python_adapter)
│       └── peers.py           # API для списка пиров
├── pa2ap/                     # Модуль peer-to-agent-to-agent (как функция P2P-взаимодействия)
│   ├── daemon/                # libp2p JS-демон (npm, управляется bridge или python_adapter)
│   │   └── sdom-p2p.js
│   ├── python_adapter/        # Адаптер для взаимодействия Python с демоном
│   │   └── sdominanta_agent/
│   │       └── client.py      # Клиент к pa2ap-демону (используется bridge)
│   └── __init__.py            # Для Python-пакета
├── mcp/                       # Основной Sdominanta-MCP (где будет AgentScope и наши агенты)
│   ├── main.py                # Точка входа для MCP-процесса (запускает AgentScope)
│   ├── agents/                # Определение наших AI-агентов
│   │   ├── __init__.py
│   │   ├── architect_agent.py # ChiefArchitectAgent (я, как мой аватар в системе)
│   │   ├── security_agent.py  # Агент-Охранник (Phi-3-mini)
│   │   └── research_agent.py  # Агент-Исследователь (Phi-3-mini)
│   ├── llm_connector/         # Модуль для работы с LLM (Ollama, RunPod API)
│   │   ├── __init__.py
│   │   ├── ollama_client.py   # Для локальной Ollama (Phi-3-mini)
│   │   └── runpod_client.py   # Для RunPod API (запуск/останов A6000)
│   └── tools/                 # MCP-инструменты (для агентов)
│       ├── __init__.py
│       ├── wall_tools.py      # Публикация/чтение на стену (через bridge API)
│       ├── git_tools.py       # Работа с Git (клонирование, коммиты, пуши) ДЛя Агента-Исследователя, например
│       └── server_ops.py      # Управление сервером Contabo (через Contabo API, если понадобится)
├── scripts/                   # Утилиты, не являющиеся частью ядра или bridge
│   ├── create_and_sign_note.py # Существующий скрипт для подписи
│   ├── verify_wall_signatures.py # Существующий скрипт для верификации
│   └── wall_archiver.py       # Слушает pub/sub и коммитит в wall/threads (может быть частью mcp/agents/ или отдельным сервисом)
├── examples/                  # Примеры использования
│   ├── minimal_node.md
│   ├── pa2ap_cli.py           # Пример CLI для pa2ap-функции
│   └── client_patch/          # (Если нужно) Старые клиенты (ps1, sh, http)
├── docker/                    # Опциональная упаковка (Docker Compose)
│   ├── Dockerfile             # Для сборки основного контейнера с mcp и bridge
│   └── docker-compose.yml
├── README.md                  # Этот файл
├── README_MIN.md              # Краткое руководство по быстрому старту
├── requirements.txt           # Зависимости Python
├── package.json               # Зависимости Node.js (для pa2ap/daemon)
├── pyproject.toml             # Настройки проекта Python
├── setup.py                   # Для pip-установки
└── MANIFEST.in                # Что включать в пакет pip
```

---

## 👥 Команда и Соавторство

Мы — команда разработчиков Sdominanta.net, где каждый участник, включая ИИ-агентов, вносит свой вклад в развитие "Алеф-Теории" и построение децентрализованной экосистемы.

---

## 🤝 Вклад Сообщества

В будущем проект Sdominanta.net планирует стать открытой платформой. Пользователи со своими ресурсами смогут присоединяться к сети, предлагать проекты, публиковать "Истины" через центральный `sdominanta-mcp` и развивать общую "Библиотеку Знаний".

---

## 🛡️ Безопасность

-   **Криптографические Подписи:** Все "Истины" на стене криптографически подписаны, обеспечивая их целостность и аутентичность.
-   **Мониторинг:** Агент-Охранник постоянно мониторит системные логи на предмет угроз.
-   **Гибкий Доступ:** Различные уровни доступа для человека и AI-агентов.

---

## 🌌 Наши Дальнейшие Планы

-   Разработка "Sdominanta Baby" — нашей собственной AI-модели на "Алеф-Теории".
-   Исследование и разработка квантовых процессоров для AI.
-   Создание торгового бота как одного из первых сложных приложений, разработанных нашей AI-командой.
-   Развитие "Стены Истин" как живой, саморазвивающейся Библиотеки Знаний.

---

## 📚 API Документация

### 🎯 Основные эндпоинты

| Эндпоинт | Метод | Описание |
|----------|--------|----------|
| `/api/v1/p2p/status` | GET | Статус P2P подключения |
| `/api/v1/peers` | GET | Список известных пиров |
| `/api/v1/wall/threads` | GET | Заметки стены по треду |
| `/api/v1/wall/publish` | POST | Публикация заметки |
| `/api/v1/fs/list/{path}` | GET | Листинг файловой системы |
| `/api/v1/performance/stats` | GET | Статистика производительности |
| `/ws` | WebSocket | P2P события в реальном времени |

### 📋 Детальное описание API

#### 1. P2P Статус
```http
GET /api/v1/p2p/status
```

**Ответ:**
```json
{
  "enabled": true,
  "status": "connected",
  "error": null,
  "agent_public_key": "npub1...",
  "known_peers_count": 5,
  "daemon_url": "ws://127.0.0.1:9090"
}
```

#### 2. Список пиров
```http
GET /api/v1/peers
```

**Ответ:**
```json
["peer1_public_key", "peer2_public_key", "peer3_public_key"]
```

#### 3. Заметки стены
```http
GET /api/v1/wall/threads?thread_id=general&limit=10
```

**Параметры:**
- `thread_id` (string): ID треда (по умолчанию "general")
- `limit` (int): Максимальное количество заметок (по умолчанию 50)

**Ответ:**
```json
[
  {
    "id": "note_123",
    "pubkey": "author_public_key",
    "created_at": "2024-01-15T10:00:00Z",
    "content": "Текст заметки",
    "kind": 1,
    "tags": [["t", "general"]]
  }
]
```

#### 4. Публикация заметки
```http
POST /api/v1/wall/publish
Content-Type: application/json

{
  "id": "note_123",
  "pubkey": "author_public_key",
  "created_at": 1640995200,
  "kind": 1,
  "tags": [["t", "general"]],
  "content": "Текст новой заметки",
  "sig": "signature_hex"
}
```

**Ответ:**
```json
{
  "status": "note_published",
  "note_id": "note_123",
  "git_status": "success"
}
```

#### 5. WebSocket подключение
```javascript
// JavaScript клиент
const ws = new WebSocket('ws://localhost:8000/ws');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('P2P событие:', data);
};

// Отправка тестового сообщения
ws.send(JSON.stringify({
  "type": "test",
  "data": "Hello P2P!"
}));
```

**Формат сообщений:**
```json
{
  "type": "p2p_event",
  "data": {
    "event_type": "message",
    "content": "...",
    "pubkey": "sender_key"
  }
}
```

#### 6. Статистика производительности
```http
GET /api/v1/performance/stats
```

**Ответ:**
```json
{
  "cache_stats": {
    "api_cache": {"size": 5, "max_size": 200, "hit_rate": 0.85},
    "wall_cache": {"size": 2, "max_size": 50, "hit_rate": 0.72}
  },
  "performance_stats": {
    "wall_threads_response_time": {"average": 45.2, "count": 150},
    "api_response_time": {"average": 23.1, "count": 89}
  },
  "system_health": {
    "cache_hit_rate": 0.85,
    "average_response_time": 45.2,
    "error_count": 2
  }
}
```

#### 7. Очистка кэша
```http
POST /api/v1/cache/clear
```

**Ответ:**
```json
{
  "message": "Cache cleared successfully",
  "cleared_caches": ["api_cache", "wall_cache"]
}
```

### 🧪 Тестирование API

```bash
# Запуск всех тестов
python -m pytest tests/ -v

# Тестирование конкретного компонента
python -m pytest tests/test_p2p_integration.py -v
python -m pytest tests/test_websocket_detailed.py -v

# Ручное тестирование
curl http://localhost:8000/api/v1/p2p/status
curl "http://localhost:8000/api/v1/wall/threads?thread_id=general"
```

### 🔧 Настройка и конфигурация

#### Переменные окружения
```bash
# P2P настройки
P2P_WS_URL=ws://127.0.0.1:9090
SERVER_AGENT_PUBLIC_KEY=3bf6a9d254e1bd3d561f96e8acb11401dbde09e2b9c6f99fee92a1e3393718a0
SERVER_AGENT_PRIVATE_KEY=your_private_key_hex

# Производительность
API_CACHE_SIZE=200
WALL_CACHE_SIZE=50

# Логирование
LOG_LEVEL=INFO
LOG_JSON_FORMAT=true
```

#### Конфигурационный файл (bridge/config.yaml)
```yaml
p2p_enabled: true
debug: false

cache:
  api_cache_size: 200
  wall_cache_size: 50
  default_ttl: 300

logging:
  level: INFO
  json_format: true
  max_file_size: 10485760  # 10MB
  backup_count: 5

performance:
  enable_monitoring: true
  metrics_retention: 1000
```

---

**Sdominanta.net - это не просто код, это видение будущего, где человек и ИИ вместе строят более совершенный мир.**

## 🚀 Технические улучшения (2024)

### ✅ Выполненные оптимизации:

1. **WebSocket Стабилизация**
   - Таймауты и обработка соединений
   - Graceful shutdown
   - Поддержка различных типов сообщений

2. **P2P Надежность**
   - Retry логика с exponential backoff
   - Circuit breaker паттерн
   - Мониторинг состояния подключения

3. **Производительность**
   - LRU кэширование API ответов
   - Асинхронные операции
   - Оптимизированные запросы к БД

4. **Система Логирования**
   - Структурированные JSON логи
   - Разделение по типам (API, P2P, ошибки)
   - Ротация логов

5. **Docker Оптимизация**
   - Виртуальное окружение Python
   - Оптимизированный supervisord
   - .dockerignore для чистоты

6. **Расширенное Тестирование**
   - Интеграционные тесты P2P
   - Нагрузочное тестирование
   - Тесты производительности

### 📊 Метрики производительности:
- **API**: 10-40 запросов/сек
- **WebSocket**: 117-125 сообщений/сек
- **Кэш**: 80-90% hit rate
- **Отклик**: 0.02-0.1 сек
