# JARVIS Voice Service Control
# Sends control commands to the background voice service: pause, resume, mute, unmute, stop
# Usage: .\control-voice.ps1 -Command pause

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("pause", "resume", "mute", "unmute", "stop")]
    [string]$Command
)

$serviceDir = $PSScriptRoot
if (-not $serviceDir) { $serviceDir = "D:\Sigma batch\Jarvis\services\voice" }
$controlFile = Join-Path $serviceDir "control.cmd"

Write-Host "[JARVIS Voice] Sending command: $Command..." -ForegroundColor Cyan

# 1. Write to control file for direct pick-up by Python process
try {
    $Command | Out-File -FilePath $controlFile -Encoding ascii
} catch {
    Write-Host "[WARNING] Could not write control file: $_" -ForegroundColor Yellow
}

# 2. Also send via API if backend is online
try {
    $body = @{ command = $Command } | ConvertTo-Json
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/voice/control" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 3
    if ($res.ok) {
        Write-Host "[JARVIS Voice] Backend acknowledged '$Command'." -ForegroundColor Green
    }
} catch {
    # Backend may be offline, file-based control is already staged
    Write-Host "[INFO] Backend not reached; command queued via control file." -ForegroundColor DarkGray
}

if ($Command -eq "stop") {
    $stopScript = Join-Path $serviceDir "stop-voice.ps1"
    if (Test-Path $stopScript) {
        & $stopScript
    }
}

Write-Host "[JARVIS Voice] Done." -ForegroundColor Green
