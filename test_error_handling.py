#!/usr/bin/env python3
"""
Тестирование системы обработки ошибок
"""

import asyncio
from bridge.error_handler import (
    AsyncRetry, CircuitBreaker, safe_websocket_send,
    safe_p2p_operation, RetryConfig, CircuitBreakerConfig
)

class MockWebSocket:
    """Мок WebSocket для тестирования"""

    def __init__(self, should_fail=False, fail_count=0):
        self.should_fail = should_fail
        self.fail_count = fail_count
        self.call_count = 0
        self.sent_messages = []

    async def send_json(self, message):
        self.call_count += 1
        self.sent_messages.append(message)

        if self.should_fail and self.call_count <= self.fail_count:
            raise ConnectionError("Mock WebSocket error")

        return True

async def test_async_retry():
    """Тестирование AsyncRetry"""
    print("\n=== Тестирование AsyncRetry ===")

    # Тест 1: Успешная операция
    print("Тест 1: Успешная операция")
    config = RetryConfig(max_attempts=3, base_delay=0.1)
    retry = AsyncRetry(config)

    call_count = 0
    async def successful_operation():
        nonlocal call_count
        call_count += 1
        return f"success_{call_count}"

    result = await retry.execute(successful_operation)
    print(f"✅ Результат: {result}, вызовов: {call_count}")

    # Тест 2: Операция с ошибками, но успешная в конце
    print("\nТест 2: Операция с временными ошибками")
    call_count = 0
    async def failing_operation():
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise ConnectionError(f"Attempt {call_count} failed")
        return f"final_success_{call_count}"

    result = await retry.execute(failing_operation)
    print(f"✅ Результат после {call_count} попыток: {result}")

    # Тест 3: Полная неудача
    print("\nТест 3: Полная неудача")
    call_count = 0
    async def always_failing():
        nonlocal call_count
        call_count += 1
        raise ValueError(f"Always fails, attempt {call_count}")

    try:
        await retry.execute(always_failing)
        print("❌ Ожидалось исключение")
    except ValueError as e:
        print(f"✅ Корректно получено исключение: {e}")

async def test_circuit_breaker():
    """Тестирование CircuitBreaker"""
    print("\n=== Тестирование CircuitBreaker ===")

    config = CircuitBreakerConfig(failure_threshold=2, recovery_timeout=1.0)
    cb = CircuitBreaker(config)

    # Тест 1: Успешные операции
    print("Тест 1: Успешные операции")
    async def success_op():
        return "success"

    for i in range(3):
        result = await cb.call(success_op)
        print(f"✅ Попытка {i+1}: {result}, статус: {cb.state.value}")

    # Тест 2: Операции с ошибками
    print("\nТест 2: Операции с ошибками")
    call_count = 0
    async def fail_op():
        nonlocal call_count
        call_count += 1
        raise ConnectionError(f"Fail {call_count}")

    # Должно сработать несколько раз, затем OPEN
    for i in range(4):
        try:
            result = await cb.call(fail_op)
            print(f"❌ Неожиданный успех: {result}")
        except (ConnectionError, Exception) as e:
            print(f"⚠️  Ожидаемая ошибка {i+1}: {e}, статус: {cb.state.value}")

    # Тест 3: Восстановление
    print("\nТест 3: Восстановление после таймаута")
    await asyncio.sleep(1.1)  # Ждем recovery_timeout

    try:
        result = await cb.call(success_op)
        print(f"✅ Восстановление успешно: {result}, статус: {cb.state.value}")
    except Exception as e:
        print(f"❌ Восстановление не удалось: {e}")

async def test_safe_websocket_send():
    """Тестирование safe_websocket_send"""
    print("\n=== Тестирование safe_websocket_send ===")

    # Тест 1: Успешная отправка
    print("Тест 1: Успешная отправка")
    ws = MockWebSocket(should_fail=False)
    result = await safe_websocket_send(ws, {"type": "test", "data": "success"})
    print(f"✅ Результат: {result}, сообщений отправлено: {len(ws.sent_messages)}")

    # Тест 2: Неудачная отправка
    print("\nТест 2: Неудачная отправка")
    ws = MockWebSocket(should_fail=True, fail_count=1)
    result = await safe_websocket_send(ws, {"type": "test", "data": "fail"})
    print(f"✅ Безопасная обработка ошибки: {result}")

async def main():
    print("=" * 50)
    print("ТЕСТИРОВАНИЕ СИСТЕМЫ ОБРАБОТКИ ОШИБОК")
    print("=" * 50)

    await test_async_retry()
    await test_circuit_breaker()
    await test_safe_websocket_send()

    print("\n" + "=" * 50)
    print("✅ Тестирование обработки ошибок завершено!")
    print("=" * 50)

if __name__ == "__main__":
    asyncio.run(main())
