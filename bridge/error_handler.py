"""
Модуль для обработки ошибок с retry логикой и circuit breaker паттерном
"""
import asyncio
import logging
from typing import Callable, Any, Optional
from dataclasses import dataclass
from enum import Enum
import time

logger = logging.getLogger(__name__)

class CircuitBreakerState(Enum):
    CLOSED = "closed"      # Нормальная работа
    OPEN = "open"          # Отказ в обслуживании
    HALF_OPEN = "half_open"  # Тестирование восстановления

@dataclass
class RetryConfig:
    max_attempts: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0
    exponential_backoff: bool = True
    jitter: bool = True

@dataclass
class CircuitBreakerConfig:
    failure_threshold: int = 5
    recovery_timeout: float = 60.0
    expected_exception: tuple = (Exception,)

class CircuitBreaker:
    """Реализация Circuit Breaker паттерна"""

    def __init__(self, config: CircuitBreakerConfig):
        self.config = config
        self.state = CircuitBreakerState.CLOSED
        self.failure_count = 0
        self.last_failure_time = 0
        self.success_count = 0

    def _should_attempt_reset(self) -> bool:
        """Проверяет, можно ли попытаться сбросить circuit breaker"""
        if self.state != CircuitBreakerState.OPEN:
            return True

        if time.time() - self.last_failure_time >= self.config.recovery_timeout:
            self.state = CircuitBreakerState.HALF_OPEN
            logger.info("Circuit breaker moved to HALF_OPEN state")
            return True

        return False

    def _record_success(self):
        """Записывает успешную операцию"""
        if self.state == CircuitBreakerState.HALF_OPEN:
            self.success_count += 1
            # После нескольких успешных операций возвращаемся к нормальной работе
            if self.success_count >= 2:
                self.state = CircuitBreakerState.CLOSED
                self.failure_count = 0
                self.success_count = 0
                logger.info("Circuit breaker moved to CLOSED state")
        elif self.state == CircuitBreakerState.CLOSED:
            self.failure_count = 0

    def _record_failure(self):
        """Записывает неудачную операцию"""
        self.failure_count += 1
        self.last_failure_time = time.time()

        if self.failure_count >= self.config.failure_threshold:
            self.state = CircuitBreakerState.OPEN
            logger.warning(f"Circuit breaker moved to OPEN state after {self.failure_count} failures")

    async def call(self, func: Callable, *args, **kwargs) -> Any:
        """Выполняет функцию через circuit breaker"""
        if not self._should_attempt_reset():
            raise Exception("Circuit breaker is OPEN - service unavailable")

        try:
            result = await func(*args, **kwargs)
            self._record_success()
            return result
        except self.config.expected_exception as e:
            self._record_failure()
            raise e

class AsyncRetry:
    """Класс для реализации retry логики с асинхронными функциями"""

    def __init__(self, config: RetryConfig):
        self.config = config

    async def execute(self, func: Callable, *args, **kwargs) -> Any:
        """Выполняет функцию с retry логикой"""
        last_exception = None

        for attempt in range(self.config.max_attempts):
            try:
                return await func(*args, **kwargs)
            except Exception as e:
                last_exception = e

                if attempt == self.config.max_attempts - 1:
                    logger.error(f"Function {func.__name__} failed after {self.config.max_attempts} attempts")
                    raise e

                # Рассчитываем задержку
                delay = self._calculate_delay(attempt)
                logger.warning(f"Attempt {attempt + 1} failed for {func.__name__}: {e}. Retrying in {delay:.2f}s")
                await asyncio.sleep(delay)

        raise last_exception

    def _calculate_delay(self, attempt: int) -> float:
        """Рассчитывает задержку для следующей попытки"""
        if not self.config.exponential_backoff:
            delay = self.config.base_delay
        else:
            delay = self.config.base_delay * (2 ** attempt)

        # Ограничиваем максимальную задержку
        delay = min(delay, self.config.max_delay)

        # Добавляем jitter для предотвращения thundering herd
        if self.config.jitter:
            import random
            delay = delay * (0.5 + random.random() * 0.5)

        return delay

# Глобальные экземпляры для использования в приложении
default_retry_config = RetryConfig(
    max_attempts=3,
    base_delay=1.0,
    max_delay=30.0,
    exponential_backoff=True,
    jitter=True
)

default_circuit_breaker_config = CircuitBreakerConfig(
    failure_threshold=5,
    recovery_timeout=60.0,
    expected_exception=(Exception,)
)

# Глобальные экземпляры
p2p_retry = AsyncRetry(default_retry_config)
p2p_circuit_breaker = CircuitBreaker(default_circuit_breaker_config)

async def safe_p2p_operation(func: Callable, *args, **kwargs) -> Any:
    """Безопасное выполнение P2P операции с retry и circuit breaker"""
    async def wrapped_func():
        return await func(*args, **kwargs)

    return await p2p_circuit_breaker.call(p2p_retry.execute, wrapped_func)

async def safe_websocket_send(websocket, message: dict):
    """Безопасная отправка сообщения через WebSocket"""
    try:
        await websocket.send_json(message)
        return True
    except Exception as e:
        logger.error(f"Failed to send WebSocket message: {e}")
        return False

def log_error_with_context(error: Exception, context: str, extra_data: Optional[dict] = None):
    """Логирование ошибки с контекстом"""
    error_info = {
        "error_type": type(error).__name__,
        "error_message": str(error),
        "context": context,
        "timestamp": time.time()
    }

    if extra_data:
        error_info.update(extra_data)

    # Избегаем конфликта с зарезервированными ключами logging
    safe_error_info = {}
    for key, value in error_info.items():
        if key not in ["message", "asctime"]:  # Зарезервированные ключи
            safe_error_info[key] = value

    logger.error(f"Error in {context}: {error}", extra=safe_error_info)
