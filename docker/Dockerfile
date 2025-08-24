# Этап 1: Сборка Node.js зависимостей
FROM node:18-alpine AS builder-node
WORKDIR /app
COPY package.json package-lock.json ./
COPY pa2ap/daemon/package.json ./pa2ap/daemon/
RUN npm install --prefix ./pa2ap/daemon

# Этап 2: Основной образ приложения
FROM python:3.10-slim-bullseye

# Установка системных зависимостей, включая supervisor
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    wait-for-it \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# Создание непривилегированного пользователя
RUN useradd --system --create-home sdominanta

# Установка Python зависимостей
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Копирование кода приложения и собранных Node.js модулей
COPY --chown=sdominanta:sdominanta bridge ./bridge
COPY --chown=sdominanta:sdominanta mcp ./mcp
COPY --chown=sdominanta:sdominanta ncp_server ./ncp_server
COPY --chown=sdominanta:sdominanta pa2ap ./pa2ap
COPY --chown=sdominanta:sdominanta scripts ./scripts
COPY --chown=sdominanta:sdominanta wall ./wall
COPY --chown=sdominanta:sdominanta CONTEXT_SEED.json TELEMETRY_SCHEMA.json ./
COPY --from=builder-node /app/pa2ap/daemon/node_modules ./pa2ap/daemon/node_modules

# Копирование конфигурации supervisor
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Создание директории для логов и установка прав
RUN mkdir -p /var/log/sdominanta && \
    chown -R sdominanta:sdominanta /var/log/sdominanta && \
    chown -R sdominanta:sdominanta /app

# Переключение на непривилегированного пользователя
USER sdominanta

# Запуск supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
