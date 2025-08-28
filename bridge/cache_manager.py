"""
Модуль для кэширования и оптимизации производительности
"""

import asyncio
import time
import hashlib
from typing import Dict, Any, Optional, Callable, Awaitable
from dataclasses import dataclass
from functools import wraps
import threading
from concurrent.futures import ThreadPoolExecutor
import json


@dataclass
class CacheEntry:
    """Запись в кэше"""
    data: Any
    timestamp: float
    ttl: int  # Time to live in seconds
    access_count: int = 0
    last_access: float = 0

    def is_expired(self) -> bool:
        """Проверяет, истек ли срок действия записи"""
        return time.time() - self.timestamp > self.ttl

    def touch(self):
        """Обновляет время последнего доступа"""
        self.last_access = time.time()
        self.access_count += 1


class LRUCache:
    """LRU кэш с поддержкой TTL"""

    def __init__(self, max_size: int = 100, default_ttl: int = 300):
        self.max_size = max_size
        self.default_ttl = default_ttl
        self.cache: Dict[str, CacheEntry] = {}
        self.access_order: Dict[str, float] = {}
        self._lock = threading.Lock()

    def _make_key(self, *args, **kwargs) -> str:
        """Создает ключ кэша из аргументов"""
        key_data = {
            'args': args,
            'kwargs': kwargs
        }
        key_str = json.dumps(key_data, sort_keys=True, default=str)
        return hashlib.md5(key_str.encode()).hexdigest()

    def get(self, key: str) -> Optional[Any]:
        """Получает значение из кэша"""
        with self._lock:
            if key in self.cache:
                entry = self.cache[key]
                if entry.is_expired():
                    del self.cache[key]
                    del self.access_order[key]
                    return None

                entry.touch()
                self.access_order[key] = entry.last_access
                return entry.data
            return None

    def put(self, key: str, value: Any, ttl: Optional[int] = None):
        """Сохраняет значение в кэш"""
        with self._lock:
            if ttl is None:
                ttl = self.default_ttl

            entry = CacheEntry(
                data=value,
                timestamp=time.time(),
                ttl=ttl
            )

            # Если кэш полон, удаляем наименее используемый элемент
            if len(self.cache) >= self.max_size and key not in self.cache:
                oldest_key = min(self.access_order, key=self.access_order.get)
                del self.cache[oldest_key]
                del self.access_order[oldest_key]

            self.cache[key] = entry
            self.access_order[key] = time.time()

    def clear(self):
        """Очищает кэш"""
        with self._lock:
            self.cache.clear()
            self.access_order.clear()

    def cleanup_expired(self):
        """Удаляет истекшие записи"""
        with self._lock:
            expired_keys = [k for k, v in self.cache.items() if v.is_expired()]
            for key in expired_keys:
                del self.cache[key]
                del self.access_order[key]

    def stats(self) -> Dict[str, Any]:
        """Возвращает статистику кэша"""
        with self._lock:
            total_access = sum(entry.access_count for entry in self.cache.values())
            return {
                'size': len(self.cache),
                'max_size': self.max_size,
                'total_access_count': total_access,
                'hit_rate': total_access / max(1, sum(len(self.cache) for _ in range(total_access)))
            }


class AsyncTaskManager:
    """Менеджер асинхронных задач"""

    def __init__(self, max_workers: int = 4):
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.tasks: Dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    async def run_in_thread(self, func: Callable, *args, **kwargs) -> Any:
        """Выполняет синхронную функцию в отдельном потоке"""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(self.executor, func, *args, **kwargs)

    async def create_task(self, coro: Awaitable, task_id: str) -> asyncio.Task:
        """Создает асинхронную задачу с ID"""
        async with self._lock:
            if task_id in self.tasks:
                # Если задача уже существует, возвращаем её
                return self.tasks[task_id]

            task = asyncio.create_task(coro)
            self.tasks[task_id] = task

            # Удаляем задачу из словаря после завершения
            task.add_done_callback(lambda t: self._remove_task(task_id))
            return task

    def _remove_task(self, task_id: str):
        """Удаляет задачу из словаря"""
        if task_id in self.tasks:
            del self.tasks[task_id]

    async def cancel_task(self, task_id: str):
        """Отменяет задачу по ID"""
        async with self._lock:
            if task_id in self.tasks:
                self.tasks[task_id].cancel()
                del self.tasks[task_id]

    async def get_active_tasks(self) -> Dict[str, asyncio.Task]:
        """Возвращает активные задачи"""
        async with self._lock:
            return self.tasks.copy()

    async def cleanup(self):
        """Очищает все активные задачи"""
        async with self._lock:
            for task in self.tasks.values():
                if not task.done():
                    task.cancel()
            self.tasks.clear()
        await self.executor.shutdown(wait=True)


def cached_async(cache: LRUCache, ttl: Optional[int] = None):
    """Декоратор для кэширования результатов асинхронных функций"""
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            cache_key = cache._make_key(func.__name__, *args, **kwargs)
            cached_result = cache.get(cache_key)

            if cached_result is not None:
                return cached_result

            try:
                result = await func(*args, **kwargs)
                cache.put(cache_key, result, ttl)
                return result
            except Exception as e:
                # Не кэшируем исключения, особенно HTTPException
                if hasattr(e, 'status_code') and e.status_code >= 400:
                    # Это HTTP ошибка, не кэшируем
                    raise e
                # Для других исключений тоже не кэшируем
                raise e

        return wrapper
    return decorator


class ConnectionPool:
    """Пул соединений для оптимизации"""

    def __init__(self, max_connections: int = 10):
        self.max_connections = max_connections
        self.connections = []
        self._lock = asyncio.Lock()

    async def acquire(self):
        """Получает соединение из пула"""
        async with self._lock:
            if len(self.connections) < self.max_connections:
                # Создаем новое соединение
                connection = await self._create_connection()
                self.connections.append(connection)
                return connection
            else:
                # Ждем доступное соединение
                while len(self.connections) >= self.max_connections:
                    await asyncio.sleep(0.1)
                return await self.acquire()

    async def release(self, connection):
        """Возвращает соединение в пул"""
        async with self._lock:
            if connection in self.connections:
                self.connections.remove(connection)

    async def _create_connection(self):
        """Создает новое соединение (заглушка)"""
        # Здесь должна быть логика создания реального соединения
        await asyncio.sleep(0.01)  # Имитация создания соединения
        return f"connection_{len(self.connections)}"

    async def cleanup(self):
        """Очищает пул соединений"""
        async with self._lock:
            self.connections.clear()


class PerformanceMonitor:
    """Монитор производительности"""

    def __init__(self):
        self.metrics: Dict[str, list] = {}
        self._lock = threading.Lock()

    def record_metric(self, name: str, value: float):
        """Записывает метрику"""
        with self._lock:
            if name not in self.metrics:
                self.metrics[name] = []
            self.metrics[name].append((time.time(), value))

            # Ограничиваем размер истории
            if len(self.metrics[name]) > 1000:
                self.metrics[name] = self.metrics[name][-500:]

    def get_average(self, name: str, last_n: int = 10) -> Optional[float]:
        """Возвращает среднее значение метрики"""
        with self._lock:
            if name not in self.metrics:
                return None

            values = [v for _, v in self.metrics[name][-last_n:]]
            return sum(values) / len(values) if values else None

    def get_stats(self) -> Dict[str, Dict[str, Any]]:
        """Возвращает статистику по всем метрикам"""
        with self._lock:
            stats = {}
            for name, data in self.metrics.items():
                if not data:
                    continue

                values = [v for _, v in data]
                stats[name] = {
                    'count': len(values),
                    'average': sum(values) / len(values),
                    'min': min(values),
                    'max': max(values),
                    'last': values[-1] if values else None
                }

            return stats


# Глобальные экземпляры
api_cache = LRUCache(max_size=200, default_ttl=300)  # 5 минут
wall_cache = LRUCache(max_size=50, default_ttl=60)   # 1 минута
task_manager = AsyncTaskManager(max_workers=4)
connection_pool = ConnectionPool(max_connections=5)
performance_monitor = PerformanceMonitor()


async def initialize_performance_system():
    """Инициализирует систему производительности"""
    # Запускаем фоновую очистку кэша
    asyncio.create_task(cache_cleanup_worker())


async def cache_cleanup_worker():
    """Фоновая задача для очистки истекших записей кэша"""
    while True:
        try:
            api_cache.cleanup_expired()
            wall_cache.cleanup_expired()
            await asyncio.sleep(60)  # Очистка каждую минуту
        except Exception as e:
            print(f"Error in cache cleanup: {e}")
            await asyncio.sleep(60)


async def shutdown_performance_system():
    """Завершает работу системы производительности"""
    await task_manager.cleanup()
    await connection_pool.cleanup()
    api_cache.clear()
    wall_cache.clear()
