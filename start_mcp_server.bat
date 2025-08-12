@echo off
REM Запуск Sdominanta MCP сервера для всех пользователей
REM Автоматически определяет путь к проекту и запускает MCP сервер

echo Запуск Sdominanta MCP сервера...
echo.

REM Определяем текущую директорию
set "PROJECT_DIR=%~dp0"
set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

echo Проект: %PROJECT_DIR%
echo.

REM Проверяем наличие Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ОШИБКА: Python не найден в системе
    echo Установите Python 3.10+ и повторите попытку
    pause
    exit /b 1
)

REM Проверяем наличие mcp_server.py
if not exist "%PROJECT_DIR%\mcp_server.py" (
    echo ОШИБКА: mcp_server.py не найден в %PROJECT_DIR%
    pause
    exit /b 1
)

REM Устанавливаем переменные окружения для корректной работы с Unicode
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

echo Запуск MCP сервера...
echo Нажмите Ctrl+C для остановки
echo.

REM Запускаем MCP сервер
python "%PROJECT_DIR%\mcp_server.py" --base "%PROJECT_DIR%"

pause
