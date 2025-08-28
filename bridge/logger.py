"""
Расширенная система логирования для Sdominanta.net
"""

import logging
import logging.handlers
import json
import sys
import os
from datetime import datetime
from typing import Dict, Any, Optional
from pathlib import Path


class JSONFormatter(logging.Formatter):
    """Форматтер для структурированного JSON логирования"""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'function': record.funcName,
            'line': record.lineno,
            'process': record.process,
            'thread': record.thread,
        }

        # Добавляем дополнительные поля из record.__dict__
        if hasattr(record, 'extra_data') and record.extra_data:
            log_entry['extra_data'] = record.extra_data

        # Добавляем информацию об исключении
        if record.exc_info:
            log_entry['exception'] = self.formatException(record.exc_info)

        return json.dumps(log_entry, ensure_ascii=False, default=str)


class PerformanceFilter(logging.Filter):
    """Фильтр для логов производительности"""

    def filter(self, record: logging.LogRecord) -> bool:
        # Пропускаем логи производительности только если уровень DEBUG или выше
        if record.name == 'performance' and record.levelno < logging.DEBUG:
            return False
        return True


class RequestResponseFilter(logging.Filter):
    """Фильтр для HTTP запросов/ответов"""

    def filter(self, record: logging.LogRecord) -> bool:
        # Фильтруем слишком детальные HTTP логи
        if 'httpx' in record.name and record.levelno < logging.WARNING:
            return False
        return True


class LogManager:
    """Менеджер логирования для всего приложения"""

    def __init__(self, app_name: str = "sdominanta"):
        self.app_name = app_name
        self.loggers = {}
        self.setup_logging()

    def setup_logging(self):
        """Настройка системы логирования"""

        # Создаем директорию для логов
        log_dir = Path("logs")
        log_dir.mkdir(exist_ok=True)

        # Корневой логгер
        root_logger = logging.getLogger()
        root_logger.setLevel(logging.DEBUG)

        # Удаляем существующие обработчики
        for handler in root_logger.handlers[:]:
            root_logger.removeHandler(handler)

        # Консольный обработчик для development
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(logging.INFO)
        console_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        console_handler.setFormatter(console_formatter)
        console_handler.addFilter(RequestResponseFilter())
        root_logger.addHandler(console_handler)

        # Файловый обработчик для всех логов
        file_handler = logging.handlers.RotatingFileHandler(
            log_dir / f"{self.app_name}.log",
            maxBytes=10*1024*1024,  # 10MB
            backupCount=5
        )
        file_handler.setLevel(logging.DEBUG)
        file_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(funcName)s:%(lineno)d - %(message)s'
        )
        file_handler.setFormatter(file_formatter)
        root_logger.addHandler(file_handler)

        # JSON обработчик для структурированных логов
        json_handler = logging.handlers.RotatingFileHandler(
            log_dir / f"{self.app_name}.json",
            maxBytes=10*1024*1024,  # 10MB
            backupCount=5
        )
        json_handler.setLevel(logging.INFO)
        json_formatter = JSONFormatter()
        json_handler.setFormatter(json_formatter)
        root_logger.addHandler(json_handler)

        # Специфические логгеры
        self.setup_api_logger(log_dir)
        self.setup_p2p_logger(log_dir)
        self.setup_performance_logger(log_dir)
        self.setup_error_logger(log_dir)

    def setup_api_logger(self, log_dir: Path):
        """Настройка логгера для API"""
        api_logger = logging.getLogger('api')
        api_logger.setLevel(logging.DEBUG)

        # API handler
        api_handler = logging.handlers.RotatingFileHandler(
            log_dir / "api.log",
            maxBytes=5*1024*1024,  # 5MB
            backupCount=3
        )
        api_handler.setLevel(logging.DEBUG)
        api_formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s - %(extra_data)s'
        )
        api_handler.setFormatter(api_formatter)
        api_logger.addHandler(api_handler)
        api_logger.propagate = False

        self.loggers['api'] = api_logger

    def setup_p2p_logger(self, log_dir: Path):
        """Настройка логгера для P2P"""
        p2p_logger = logging.getLogger('p2p')
        p2p_logger.setLevel(logging.DEBUG)

        # P2P handler
        p2p_handler = logging.handlers.RotatingFileHandler(
            log_dir / "p2p.log",
            maxBytes=5*1024*1024,  # 5MB
            backupCount=3
        )
        p2p_handler.setLevel(logging.DEBUG)
        p2p_formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s - Peer: %(peer)s - Event: %(event)s'
        )
        p2p_handler.setFormatter(p2p_formatter)
        p2p_logger.addHandler(p2p_handler)
        p2p_logger.propagate = False

        self.loggers['p2p'] = p2p_logger

    def setup_performance_logger(self, log_dir: Path):
        """Настройка логгера для производительности"""
        perf_logger = logging.getLogger('performance')
        perf_logger.setLevel(logging.DEBUG)

        # Performance handler
        perf_handler = logging.handlers.RotatingFileHandler(
            log_dir / "performance.log",
            maxBytes=5*1024*1024,  # 5MB
            backupCount=3
        )
        perf_handler.setLevel(logging.DEBUG)
        perf_formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s - ResponseTime: %(response_time)s ms'
        )
        perf_handler.setFormatter(perf_formatter)
        perf_handler.addFilter(PerformanceFilter())
        perf_logger.addHandler(perf_handler)
        perf_logger.propagate = False

        self.loggers['performance'] = perf_logger

    def setup_error_logger(self, log_dir: Path):
        """Настройка логгера для ошибок"""
        error_logger = logging.getLogger('error')
        error_logger.setLevel(logging.ERROR)

        # Error handler
        error_handler = logging.handlers.RotatingFileHandler(
            log_dir / "errors.log",
            maxBytes=5*1024*1024,  # 5MB
            backupCount=10
        )
        error_handler.setLevel(logging.ERROR)
        error_formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s\n'
            'Module: %(module)s\n'
            'Function: %(funcName)s\n'
            'Line: %(lineno)d\n'
            'Exception: %(exc_text)s\n'
            '---'
        )
        error_handler.setFormatter(error_formatter)
        error_logger.addHandler(error_handler)
        error_logger.propagate = False

        self.loggers['error'] = error_logger

    def get_logger(self, name: str) -> logging.Logger:
        """Получить логгер по имени"""
        if name in self.loggers:
            return self.loggers[name]
        return logging.getLogger(name)

    def log_api_request(self, method: str, path: str, status_code: int,
                       response_time: float, user_agent: Optional[str] = None):
        """Логирование API запроса"""
        logger = self.get_logger('api')
        level = logging.INFO if status_code < 400 else logging.WARNING if status_code < 500 else logging.ERROR

        logger.log(level, f"{method} {path} - {status_code}",
                  extra={'extra_data': {
                      'method': method,
                      'path': path,
                      'status_code': status_code,
                      'response_time': response_time,
                      'user_agent': user_agent
                  }})

    def log_p2p_event(self, event_type: str, peer: Optional[str] = None,
                     event_data: Optional[Dict[str, Any]] = None):
        """Логирование P2P события"""
        logger = self.get_logger('p2p')

        logger.info(f"P2P Event: {event_type}",
                   extra={'peer': peer or 'unknown',
                          'event': event_type,
                          'event_data': event_data})

    def log_performance_metric(self, metric_name: str, value: float,
                              context: Optional[Dict[str, Any]] = None):
        """Логирование метрики производительности"""
        logger = self.get_logger('performance')

        logger.info(f"Performance: {metric_name} = {value}",
                   extra={'response_time': value,
                          'context': context or {}})

    def log_error(self, error: Exception, context: str,
                 extra_data: Optional[Dict[str, Any]] = None):
        """Логирование ошибки"""
        logger = self.get_logger('error')

        logger.error(f"Error in {context}: {error}",
                    extra={'extra_data': extra_data or {},
                           'error_type': type(error).__name__,
                           'error_message': str(error)},
                    exc_info=True)


# Глобальный менеджер логирования
log_manager = LogManager()

# Функции для удобного использования
def get_logger(name: str) -> logging.Logger:
    """Получить логгер"""
    return log_manager.get_logger(name)

def log_api_request(method: str, path: str, status_code: int,
                   response_time: float, user_agent: Optional[str] = None):
    """Логировать API запрос"""
    log_manager.log_api_request(method, path, status_code, response_time, user_agent)

def log_p2p_event(event_type: str, peer: Optional[str] = None,
                 event_data: Optional[Dict[str, Any]] = None):
    """Логировать P2P событие"""
    log_manager.log_p2p_event(event_type, peer, event_data)

def log_performance_metric(metric_name: str, value: float,
                           context: Optional[Dict[str, Any]] = None):
    """Логировать метрику производительности"""
    log_manager.log_performance_metric(metric_name, value, context)

def log_error(error: Exception, context: str,
             extra_data: Optional[Dict[str, Any]] = None):
    """Логировать ошибку"""
    log_manager.log_error(error, context, extra_data)


# Настройка логирования для FastAPI
def setup_fastapi_logging():
    """Настройка логирования для FastAPI"""
    # Отключаем стандартные логи FastAPI
    logging.getLogger('uvicorn').setLevel(logging.WARNING)
    logging.getLogger('uvicorn.access').setLevel(logging.WARNING)
    logging.getLogger('fastapi').setLevel(logging.WARNING)

    # Настраиваем свой логгер для HTTP запросов
    http_logger = logging.getLogger('http')
    http_logger.setLevel(logging.INFO)

    # Создаем кастомный обработчик для Uvicorn access логов
    class AccessLogHandler(logging.Handler):
        def emit(self, record):
            if 'httpx' not in record.name:  # Исключаем httpx логи
                # Парсим access лог Uvicorn
                message = record.getMessage()
                if '"' in message and 'HTTP/' in message:
                    # Это access лог
                    parts = message.split('"')
                    if len(parts) >= 3:
                        request_part = parts[1]  # "GET /api/v1/test HTTP/1.1"
                        status_part = parts[2].strip()  # " 200 "

                        if ' ' in request_part:
                            method_path = request_part.split()
                            if len(method_path) >= 2:
                                method = method_path[0]
                                path = method_path[1]

                                try:
                                    status_code = int(status_part.split()[0])
                                    log_api_request(method, path, status_code, 0.0)
                                except (ValueError, IndexError):
                                    pass

    access_handler = AccessLogHandler()
    http_logger.addHandler(access_handler)
    http_logger.propagate = False
