# Этап 1: Сборка Node.js зависимостей
FROM node:18-alpine AS builder-node
WORKDIR /app
# Копируем и устанавливаем зависимости из корневого package.json
COPY package.json package-lock.json ./
RUN npm install

# Этап 2: Основной образ приложения
FROM python:3.10-slim-bullseye

# Установка системных зависимостей
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    wait-for-it \
    nodejs \
    && rm -rf /var/lib/apt/lists/*

# Установка Python зависимостей
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Копирование кода приложения и собранных Node.js модулей
COPY . .
COPY --from=builder-node /app/node_modules ./node_modules
