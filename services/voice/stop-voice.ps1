# JARVIS Voice Service — Stop
# Gracefully stops the running Python voice service.

$serviceDir = "D:\Sigma batch\Jarvis\services\voice"
$pidFile    = "$serviceDir\jarvis-voice.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "[JARVIS Voice] No PID file found. Service may not be running." -ForegroundColor Yellow
    exit 0
}

$pid = Get-Content $pidFile -ErrorAction SilentlyContinue
if (-not $pid) {
    Write-Host "[JARVIS Voice] PID file is empty. Removing." -ForegroundColor Yellow
    Remove-Item $pidFile -Force
    exit 0
}

$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "[JARVIS Voice] Process $pid is not running. Cleaning up." -ForegroundColor Yellow
    Remove-Item $pidFile -Force
    exit 0
}

Write-Host "[JARVIS Voice] Stopping PID $pid..." -ForegroundColor Cyan

# Send graceful SIGTERM via taskkill (no force — allows cleanup).
$result = taskkill /PID $pid /T 2>&1
Start-Sleep -Milliseconds 1500

# Verify it stopped.
$stillRunning = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($stillRunning) {
    Write-Host "[JARVIS Voice] Still running. Forcing termination..." -ForegroundColor Yellow
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "[JARVIS Voice] Stopped." -ForegroundColor Green
