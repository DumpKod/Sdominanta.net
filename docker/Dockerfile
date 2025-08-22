# Sdominanta.net/docker/Dockerfile
# Базовый образ с Python
FROM python:3.10-slim-bullseye

# Установка системных зависимостей (для git, ssh и прочего)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    nodejs \
    npm \
    wait-for-it \
    && rm -rf /var/lib/apt/lists/*

# Создание пользователя sdominanta
RUN adduser --system --no-create-home sdominanta
USER sdominanta
WORKDIR /app

# Копирование файлов проекта
COPY --chown=sdominanta:sdominanta . /app

# Установка Python зависимостей
RUN pip install --no-cache-dir -r requirements.txt

# Установка Node.js зависимостей для pa2ap/daemon
WORKDIR /app/pa2ap/daemon
RUN npm install
WORKDIR /app

# Создание директории для SSH-ключей агентов (если они нужны)
RUN mkdir -p /app/.ssh && chmod 700 /app/.ssh
# TODO: Скопировать SSH-ключи в Dockerfile, либо использовать volume

# Команда по умолчанию для запуска (через docker-compose)
CMD ["/bin/bash"]
