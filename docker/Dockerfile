# Этап 1: Сборка Node.js зависимостей
FROM node:18-alpine AS builder-node
WORKDIR /app
# Копируем и устанавливаем зависимости из корневого package.json
COPY package.json package-lock.json ./
RUN npm install

# Этап 2: Основной образ приложения
FROM python:3.10-slim-bullseye

# Установка системных зависимостей, включая Node.js и supervisor
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    wait-for-it \
    supervisor \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Создание непривилегированного пользователя
RUN useradd --system --create-home sdominanta

# Создание виртуального окружения для Python
RUN python -m venv /opt/venv

# Активация виртуального окружения и установка Python зависимостей
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir sdominanta-mcp

# Установка нашего npm-пакета
WORKDIR /app
RUN npm install sdominanta-mcp
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Создание директории для логов и установка прав
RUN mkdir -p /var/log/sdominanta && \
    chown -R sdominanta:sdominanta /var/log/sdominanta && \
    chown -R sdominanta:sdominanta /app

# Переключение на непривилегированного пользователя
USER sdominanta

# Запуск supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
