# Запуск Sdominanta MCP сервера для всех пользователей
# PowerShell скрипт с расширенными возможностями

param(
    [string]$BasePath = $PSScriptRoot,
    [switch]$Install,
    [switch]$Test,
    [switch]$Help
)

if ($Help) {
    Write-Host @"
Sdominanta MCP Server Launcher

Использование:
    .\Start-McpServer.ps1 [параметры]

Параметры:
    -BasePath <путь>    Путь к проекту (по умолчанию: текущая директория)
    -Install            Установить зависимости и настроить MCP
    -Test               Протестировать MCP сервер
    -Help               Показать эту справку

Примеры:
    .\Start-McpServer.ps1                    # Запуск с текущей директорией
    .\Start-McpServer.ps1 -BasePath "C:\path\to\project"
    .\Start-McpServer.ps1 -Install           # Установка зависимостей
    .\Start-McpServer.ps1 -Test              # Тестирование
"@
    exit 0
}

# Функция для логирования
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $color = switch ($Level) {
        "ERROR" { "Red" }
        "WARN" { "Yellow" }
        "SUCCESS" { "Green" }
        default { "White" }
    }
    Write-Host "[$timestamp] [$Level] $Message" -ForegroundColor $color
}

# Функция для проверки Python
function Test-Python {
    try {
        $pythonVersion = python --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Log "Python найден: $pythonVersion" "SUCCESS"
            return $true
        }
    }
    catch {
        Write-Log "Python не найден в системе" "ERROR"
        return $false
    }
    return $false
}

# Функция для установки зависимостей
function Install-Dependencies {
    Write-Log "Установка зависимостей..." "INFO"
    
    if (-not (Test-Python)) {
        Write-Log "Python не найден. Установите Python 3.10+ и повторите попытку." "ERROR"
        return $false
    }
    
    try {
        Write-Log "Обновление pip..." "INFO"
        python -m pip install --upgrade pip
        
        Write-Log "Установка зависимостей из requirements.txt..." "INFO"
        python -m pip install -r "$BasePath\requirements.txt"
        
        Write-Log "Зависимости установлены успешно!" "SUCCESS"
        return $true
    }
    catch {
        Write-Log "Ошибка при установке зависимостей: $($_.Exception.Message)" "ERROR"
        return $false
    }
}

# Функция для тестирования MCP сервера
function Test-McpServer {
    Write-Log "Тестирование MCP сервера..." "INFO"
    
    if (-not (Test-Path "$BasePath\mcp_server.py")) {
        Write-Log "mcp_server.py не найден в $BasePath" "ERROR"
        return $false
    }
    
    try {
        Write-Log "Проверка справки MCP сервера..." "INFO"
        $helpOutput = python "$BasePath\mcp_server.py" --help 2>&1
        
        if ($LASTEXITCODE -eq 0) {
            Write-Log "MCP сервер работает корректно!" "SUCCESS"
            Write-Log "Справка: $helpOutput" "INFO"
            return $true
        } else {
            Write-Log "Ошибка при запуске MCP сервера" "ERROR"
            return $false
        }
    }
    catch {
        Write-Log "Исключение при тестировании: $($_.Exception.Message)" "ERROR"
        return $false
    }
}

# Функция для запуска MCP сервера
function Start-McpServer {
    Write-Log "Запуск Sdominanta MCP сервера..." "INFO"
    Write-Log "Проект: $BasePath" "INFO"
    Write-Log "Нажмите Ctrl+C для остановки" "INFO"
    Write-Log ""
    
    # Устанавливаем переменные окружения
    $env:PYTHONUTF8 = "1"
    $env:PYTHONIOENCODING = "utf-8"
    
    try {
        python "$BasePath\mcp_server.py" --base "$BasePath"
    }
    catch {
        Write-Log "Ошибка при запуске MCP сервера: $($_.Exception.Message)" "ERROR"
    }
}

# Основная логика
Write-Log "Sdominanta MCP Server Launcher" "INFO"
Write-Log ""

if ($Install) {
    if (Install-Dependencies) {
        Write-Log "Установка завершена успешно!" "SUCCESS"
    } else {
        Write-Log "Установка завершилась с ошибками" "ERROR"
        exit 1
    }
}

if ($Test) {
    if (Test-McpServer) {
        Write-Log "Тестирование прошло успешно!" "SUCCESS"
    } else {
        Write-Log "Тестирование завершилось с ошибками" "ERROR"
        exit 1
    }
}

if (-not $Install -and -not $Test) {
    # Проверяем зависимости перед запуском
    if (-not (Test-Path "$BasePath\requirements.txt")) {
        Write-Log "requirements.txt не найден. Попробуйте запустить с параметром -Install" "WARN"
    }
    
    Start-McpServer
}
