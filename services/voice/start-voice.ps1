# JARVIS Voice Service Launcher
# Starts the Python background voice service.
# Run from any directory.

$serviceDir  = "D:\Sigma batch\Jarvis\services\voice"
$pidFile     = "$serviceDir\jarvis-voice.pid"
$logDir      = "$serviceDir\logs"
$script      = "$serviceDir\jarvis_voice.py"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ── Check for existing process ──────────────────────────────────────────────
if (Test-Path $pidFile) {
    $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existingPid) {
        $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "[JARVIS Voice] Already running (PID $existingPid). Use stop-voice.ps1 first." -ForegroundColor Yellow
            exit 0
        }
    }
    Remove-Item $pidFile -Force
}

# ── Verify Python ────────────────────────────────────────────────────────────
$python = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if (-not $python) {
    Write-Host "[ERROR] Python not found. Install Python 3.12+ and add it to PATH." -ForegroundColor Red
    exit 1
}

# ── Verify JARVIS API is reachable ─────────────────────────────────────────
try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 3
} catch {
    Write-Host "[WARNING] JARVIS API is not responding at port 3000." -ForegroundColor Yellow
    Write-Host "          The voice service will keep retrying automatically." -ForegroundColor DarkGray
}

# ── Start the voice service in the background ───────────────────────────────
Write-Host "[JARVIS Voice] Starting background voice service..." -ForegroundColor Cyan

$logFile = "$logDir\jarvis-voice.log"

$proc = Start-Process `
    -FilePath $python `
    -ArgumentList $script `
    -WorkingDirectory $serviceDir `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError  "$logDir\jarvis-voice-err.log"

if ($proc) {
    $proc.Id | Out-File -FilePath $pidFile -Encoding utf8
    Write-Host "[JARVIS Voice] Started with PID $($proc.Id)." -ForegroundColor Green
    Write-Host "               Log: $logFile" -ForegroundColor DarkGray
    Write-Host "               Stop:  .\stop-voice.ps1" -ForegroundColor DarkGray
    Write-Host "               Pause: .\control-voice.ps1 -Command pause" -ForegroundColor DarkGray
} else {
    Write-Host "[ERROR] Failed to start the voice service." -ForegroundColor Red
    exit 1
}
