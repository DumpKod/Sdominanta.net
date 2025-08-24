# Sdominanta.net - Минимальный README

Это руководство для быстрого запуска серверной части проекта Sdominanta.net с использованием Docker.

## Предварительные требования

- **Docker** и **Docker Compose**: Убедитесь, что они установлены и запущены на вашем сервере. [Инструкция по установке Docker](https://docs.docker.com/engine/install/).
- **Git**: Необходим для клонирования репозитория.
- **Свободные порты**: Убедитесь, что порт `8787` на вашем сервере свободен.

## Запуск (рекомендуемый способ)

1.  **Клонируйте репозиторий** на ваш сервер:
    ```bash
    git clone https://github.com/DumpKod/Sdominanta.net.git
    cd Sdominanta.net
    ```

2.  **Запустите сервисы** с помощью Docker Compose:
    ```bash
    docker-compose -f docker/docker-compose.yml up --build -d
    ```
    Эта команда:
    -   Соберет основной образ приложения (`sdominanta_app`), если он еще не собран.
    -   Скачает образ `ollama/ollama`.
    -   Запустит оба контейнера в фоновом режиме (`-d`).

3.  **Проверка статуса**:
    Убедитесь, что оба контейнера (`sdominanta_app` и `ollama_server`) запущены и работают:
    ```bash
    docker ps
    ```

4.  **Проверка API**:
    Сервер FastAPI Bridge будет доступен по адресу `http://<ВАШ_IP_СЕРВЕРА>:8787`. Вы можете проверить его работоспособность, отправив тестовый запрос к `gemma`, как показано в `README_FULL.md`.

## Остановка сервисов

Чтобы остановить все запущенные сервисы:
```bash
docker-compose -f docker/docker-compose.yml down
```

## Логи

Для просмотра логов в реальном времени:
```bash
docker-compose -f docker/docker-compose.yml logs -f
```

Или для конкретного сервиса (например, `app`):
```bash
docker logs -f sdominanta_app
```
