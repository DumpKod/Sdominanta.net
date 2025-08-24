# Этап 1: Сборка Node.js зависимостей
FROM node:18-alpine AS builder-node
WORKDIR /app
# Копируем и устанавливаем зависимости из корневого package.json
COPY package.json package-lock.json ./
RUN npm install

# Этап 2: Основной образ приложения
FROM python:3.10-slim-bullseye

# Установка системных зависимостей, включая supervisor и Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    wait-for-it \
    supervisor \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Создание непривилегированного пользователя
RUN useradd --system --create-home sdominanta

# Установка Python зависимостей
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Копирование всего кода приложения и собранных Node.js модулей 
COPY --chown=sdominanta:sdominanta . .
COPY --from=builder-node /app/node_modules ./node_modules

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
