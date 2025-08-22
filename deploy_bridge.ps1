
# deploy_bridge.ps1
$RemoteUser = "root"
$RemoteHost = "62.169.28.124"
$RemotePath = "/opt/sdominanta-bridge/"
$LocalProjectPath = "B:\projects\..Sdominanta.net\Sdominanta.net" # Убедитесь, что это правильный путь к вашей папке Sdominanta.net
$SshKeyPath = "$env:HOME\.ssh\id_rsa" # Путь к вашему приватному SSH-ключу

# Определяем путь к rsync, который поставляется с Git для Windows
$RsyncPath = "C:\Program Files\Git\usr\bin\rsync.exe"
# Если Git установлен в другом месте или есть другой rsync, можно использовать:
# $RsyncPath = (Get-Command rsync -ErrorAction SilentlyContinue).Source
# if (-not $RsyncPath) { Write-Error "rsync не найден. Убедитесь, что Git for Windows установлен."; exit 1 }

Write-Host "Синхронизация проекта с VPS..."

# Используем rsync через SSH для инкрементальной синхронизации
# -a: архивный режим (рекурсивно, сохраняет разрешения, владельцев, временные метки)
# -v: подробный вывод
# -z: сжатие данных
# --delete: удаляет файлы на получателе, которых нет на отправителе (осторожно!)
# --exclude: исключает файлы/папки из синхронизации (например, git-метаданные)
# -e "ssh -i $SshKeyPath": Указываем использовать ваш SSH-ключ
& "$RsyncPath" -avz --delete `
    --exclude ".git/" `
    --exclude "node_modules/" `
    --exclude "__pycache__/" `
    --exclude "sdominanta_mcp.egg-info/" `
    --exclude ".venv/" `
    --exclude "*.log" `
    --exclude "dist/" `
    --exclude "build/" `
    -e "ssh -i '$SshKeyPath'" `
    ""$LocalProjectPath/"" `
    ""$($RemoteUser)@$($RemoteHost):$($RemotePath)""

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Синхронизация завершена успешно!"
} else {
    Write-Error "❌ Ошибка при синхронизации. Код выхода: $LASTEXITCODE"
}

Write-Host "Теперь вы можете подключиться к VPS по SSH и запустить сервер:"
Write-Host "ssh -i '$SshKeyPath' root@$($RemoteHost)"
Write-Host "Затем на VPS перейдите в /opt/sdominanta-bridge/ и запустите uvicorn."

