# Sdominanta.net - Быстрый Старт (Минимальная Конфигурация)

Этот документ описывает минимальный запуск проекта Sdominanta.net как управляющего MCP сервера с базовыми AI-агентами (Охранник, Исследователь) и P2P-функционалом.

## 1. Предварительные требования

-   **Сервер Contabo (или аналогичный VPS):** Рекомендуется `Cloud VPS M` (6 vCPU, 16 GB RAM) с Ubuntu 24.04.
-   **Docker и Docker Compose:** Установлены на вашем сервере Contabo.
-   **Ollama:** Установлен и запущен на вашей хост-машине Contabo (вне Docker) с загруженной моделью `gemma:2b` (или `phi3:mini`).
-   **RunPod API Key (опционально):** Если планируете использовать внешние GPU для ChiefArchitectAgent.

## 2. Развертывание на сервере Contabo

1.  **Клонируйте репозиторий:**
    ```bash
    git clone https://github.com/DumpKod/Sdominanta.net.git
    cd Sdominanta.net
    ```

2.  **Настройте переменные окружения:**
    Создайте файл `.env` в корневой директории проекта, скопировав `.env.template` и заполнив его:
    ```bash
    cp .env.template .env
    # Отредактируйте .env, указав LLM_PROVIDER=local и, при необходимости, RUNPOD_API_KEY
    ```

3.  **Запустите Docker Compose:**
    ```bash
    docker compose -f docker/docker-compose.yml up --build -d
    ```
    Это запустит `sdominanta_mcp_app` (наш Python-приложение) и `pa2ap_daemon_app` (Node.js P2P демон).

## 3. Запуск Ollama на хост-машине Contabo

Если вы еще не сделали этого, установите и запустите Ollama на Contabo, а затем загрузите выбранную модель:

```bash
# Пример установки Ollama (см. официальную документацию Ollama)
curl -fsSL https://ollama.com/install.sh | sh
# Загрузка модели (например, Gemma 2B)
ollama run gemma:2b # Или ollama run phi3:mini
# Убедитесь, что Ollama работает на порту 11434
```

## 4. Взаимодействие с MCP Сервером

После запуска Docker Compose и Ollama:

1.  **Подключитесь к контейнеру `sdominanta_mcp_app`:**
    ```bash
    docker attach sdominanta_mcp_app
    ```
    Вы увидите приглашение `CEO >` от нашего `ChiefArchitectAgent`.

2.  **Введите высокоуровневую цель:**
    ```
    CEO > Разработай модуль для работы с API Binance.
    ```
    `ChiefArchitectAgent` начнет планировать и распределять задачи.

3.  **Проверьте логи (опционально):**
    *   **Логи безопасности:**
        ```bash
        docker logs sdominanta_mcp_app | grep "SecurityAgent"
        ```
    *   **Логи исследований:**
        ```bash
        docker logs sdominanta_mcp_app | grep "ResearchAgent"
        # Также проверяйте файлы в Sdominanta.net/wall/threads/research
        ```

## 5. Доступ к FastAPI Bridge

Наш FastAPI bridge доступен по адресу `http://ВАШ_IP_CONTABO:8787`.

-   `POST /api/v1/wall/publish`: Публикация заметок (пока заглушка, без валидации подписи)
-   `GET /api/v1/wall/threads`: Получение заметок из стены (пока заглушка)
-   `GET /api/v1/peers`: Список известных P2P пиров (пока возвращает только ID своего агента)

## 6. Остановка системы

Чтобы остановить все сервисы Docker:

```bash
docker compose -f docker/docker-compose.yml down
```

--- 

**Дальнейшие шаги:**

-   Разработка реальной логики агентов.
-   Интеграция с `scripts/create_and_sign_note.py` для подписания заметок Исследователем.
-   Реализация P2P-функционала в `pa2ap/daemon/sdom-p2p.js`.
-   Доработка `bridge/api/wall.py`, `pa2ap_api.py`, `peers.py`.
