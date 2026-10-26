
# JARVIS Full Launcher
# Starts the API backend, frontend dashboard, and optionally the voice service.
# Usage: .\start-jarvis.ps1 [-NoVoice] [-NoBrowser]

param(
    [switch]$NoVoice,    # Skip starting the background voice service
    [switch]$NoBrowser   # Skip opening the browser dashboard
)

$project  = "D:\Sigma batch\Jarvis"
$apiDir   = "$project\services\api"
$webDir   = "$project\apps\web"
$voiceDir = "$project\services\voice"

Write-Host ""
Write-Host "  ╔══════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║     J.A.R.V.I.S. Launcher        ║" -ForegroundColor Cyan
Write-Host "  ║   Personal AI Agent v0.5.0        ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Start API Backend ──────────────────────────────────────────────────────
Write-Host "[1/3] Starting JARVIS API backend..." -ForegroundColor White
Start-Process -FilePath "cmd.exe" `
    -ArgumentList '/k', "title JARVIS-API && cd /d `"$apiDir`" && node src/server.js" `
    -WorkingDirectory $apiDir

Start-Sleep -Seconds 4

# Verify API is up.
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5
    Write-Host "    API online — Provider: $($health.provider)" -ForegroundColor Green
} catch {
    Write-Host "    API not responding yet — continuing anyway." -ForegroundColor Yellow
}

# ── Start Frontend ─────────────────────────────────────────────────────────
Write-Host "[2/3] Starting JARVIS frontend..." -ForegroundColor White
Start-Process -FilePath "cmd.exe" `
    -ArgumentList '/k', "title JARVIS-UI && cd /d `"$webDir`" && npm run dev -- --host 127.0.0.1" `
    -WorkingDirectory $webDir

Start-Sleep -Seconds 4

# ── Voice Service ──────────────────────────────────────────────────────────
if (-not $NoVoice) {
    Write-Host "[3/3] Starting background voice service..." -ForegroundColor White
    & "$voiceDir\start-voice.ps1"
} else {
    Write-Host "[3/3] Voice service skipped (-NoVoice)." -ForegroundColor DarkGray
}

# ── Open Dashboard ─────────────────────────────────────────────────────────
if (-not $NoBrowser) {
    Start-Sleep -Seconds 2
    Write-Host ""
    Write-Host "  Opening dashboard at http://localhost:5173" -ForegroundColor Cyan
    Start-Process "http://localhost:5173"
}

Write-Host ""
Write-Host "  JARVIS is running. Say 'Hey JARVIS' to activate the voice assistant." -ForegroundColor Green
Write-Host "  Status: .\scripts\manage-jarvis.ps1 -Action status" -ForegroundColor DarkGray
Write-Host "  Stop:   .\scripts\manage-jarvis.ps1 -Action stop" -ForegroundColor DarkGray
Write-Host ""
