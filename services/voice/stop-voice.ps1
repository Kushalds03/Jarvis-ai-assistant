# JARVIS Voice Service -- Stop
# Gracefully stops the running Python voice service.

$serviceDir = $PSScriptRoot
if (-not $serviceDir) { $serviceDir = "D:\Sigma batch\Jarvis\services\voice" }
$pidFile    = Join-Path $serviceDir "jarvis-voice.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "[JARVIS Voice] No PID file found. Service may not be running." -ForegroundColor Yellow
    exit 0
}

$pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue
if (-not $pidValue) {
    Write-Host "[JARVIS Voice] PID file is empty. Removing." -ForegroundColor Yellow
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
}

$proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "[JARVIS Voice] Process $pidValue is not running. Cleaning up." -ForegroundColor Yellow
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
}

# Safety check: ensure the PID is actually a python process before terminating!
if ($proc.ProcessName -notmatch "python") {
    Write-Host "[JARVIS Voice] Warning: PID $pidValue is '$($proc.ProcessName)', not Python. Skipping termination." -ForegroundColor Red
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "[JARVIS Voice] Stopping PID $pidValue..." -ForegroundColor Cyan

# Send graceful SIGTERM via taskkill
taskkill /PID $pidValue /T 2>&1 | Out-Null
Start-Sleep -Milliseconds 1500

# Verify it stopped
$stillRunning = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if ($stillRunning) {
    Write-Host "[JARVIS Voice] Still running. Forcing termination..." -ForegroundColor Yellow
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "[JARVIS Voice] Stopped." -ForegroundColor Green
