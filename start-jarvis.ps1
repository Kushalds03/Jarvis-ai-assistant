# JARVIS Full Launcher
# Starts the API backend, frontend dashboard, and optionally the voice service.
#
# Usage:
#   .\start-jarvis.ps1               # Development mode (API + UI + Voice + Browser)
#   .\start-jarvis.ps1 -NoVoice      # Development mode without voice service
#   .\start-jarvis.ps1 -NoBrowser    # Development mode without opening browser
#   .\start-jarvis.ps1 -Background   # Background assistant mode (API + Voice, no UI/browser)

param(
    [switch]$NoVoice,
    [switch]$NoBrowser,
    [switch]$Background
)

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = "D:\Sigma batch\Jarvis" }

$apiDir   = Join-Path $scriptDir "services\api"
$webDir   = Join-Path $scriptDir "apps\web"
$voiceDir = Join-Path $scriptDir "services\voice"

Write-Host ""
Write-Host "  +----------------------------------+" -ForegroundColor Cyan
Write-Host "  |     J.A.R.V.I.S. Launcher        |" -ForegroundColor Cyan
Write-Host "  |   Personal AI Agent v0.5.0       |" -ForegroundColor Cyan
Write-Host "  +----------------------------------+" -ForegroundColor Cyan
Write-Host ""

if ($Background) {
    Write-Host "  Mode: Background Assistant (headless API + Voice)" -ForegroundColor Magenta
} else {
    Write-Host "  Mode: Development (API + UI + Browser)" -ForegroundColor Gray
}
Write-Host ""

# Helper to test if a port is listening locally
function Test-PortListening {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $wait = $asyncResult.AsyncWaitHandle.WaitOne(400, $false)
        if ($wait -and $client.Connected) {
            $client.EndConnect($asyncResult)
            $client.Close()
            return $true
        }
    } catch {
        # Not listening
    } finally {
        $client.Close()
    }
    return $false
}

# Helper to query process information on a port without terminating it
function Get-ProcessOnPort {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn -and $conn.OwningProcess) {
            return (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue)
        }
    } catch {}
    return $null
}

# -- 1. Start API Backend ------------------------------------------------------
Write-Host "[1/3] Checking JARVIS API backend..." -ForegroundColor White

$apiRunning = $false
if (Test-PortListening 3000) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 3
        Write-Host "    API already online on port 3000 (Provider: $($health.provider))." -ForegroundColor Green
        $apiRunning = $true
    } catch {
        $procOnPort = Get-ProcessOnPort 3000
        $procName = if ($procOnPort) { "$($procOnPort.ProcessName) (PID $($procOnPort.Id))" } else { "unknown process" }
        Write-Host "    [WARNING] Port 3000 is in use by $procName, but is not responding as JARVIS API." -ForegroundColor Yellow
        Write-Host "              Skipping API startup to prevent duplicate port collision." -ForegroundColor Yellow
        $apiRunning = $false
    }
}

if (-not $apiRunning) {
    Write-Host "    Starting JARVIS API backend..." -ForegroundColor Cyan
    if ($Background) {
        # Hidden window for background assistant mode
        Start-Process -FilePath "node" `
            -ArgumentList "src/server.js" `
            -WorkingDirectory $apiDir `
            -WindowStyle Hidden
    } else {
        # Separate console window with logs for development mode
        Start-Process -FilePath "cmd.exe" `
            -ArgumentList '/k', "title JARVIS-API & node src/server.js" `
            -WorkingDirectory $apiDir
    }

    # Poll for backend readiness up to 10 seconds
    $retries = 0
    $maxRetries = 10
    while ($retries -lt $maxRetries) {
        Start-Sleep -Seconds 1
        $retries++
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 2
            if ($health -and $health.status -eq "online") {
                Write-Host "    API online on port 3000 (Provider: $($health.provider))." -ForegroundColor Green
                $apiRunning = $true
                break
            }
        } catch {
            # Still starting
        }
    }

    if (-not $apiRunning) {
        Write-Host "    [WARNING] API backend did not respond within $maxRetries seconds." -ForegroundColor Yellow
        Write-Host "              Continuing anyway; check the JARVIS-API terminal window." -ForegroundColor DarkGray
    }
}

# -- 2. Start Frontend ---------------------------------------------------------
if ($Background) {
    Write-Host "[2/3] Frontend skipped (Background assistant mode)." -ForegroundColor DarkGray
} else {
    Write-Host "[2/3] Checking JARVIS frontend..." -ForegroundColor White

    $webRunning = $false
    if (Test-PortListening 5173) {
        Write-Host "    Frontend already running on port 5173." -ForegroundColor Green
        $webRunning = $true
    }

    if (-not $webRunning) {
        Write-Host "    Starting Vite development server..." -ForegroundColor Cyan
        Start-Process -FilePath "cmd.exe" `
            -ArgumentList '/k', "title JARVIS-UI & npm run dev -- --host 127.0.0.1" `
            -WorkingDirectory $webDir

        # Poll for frontend readiness up to 8 seconds
        $retries = 0
        $maxRetries = 8
        while ($retries -lt $maxRetries) {
            Start-Sleep -Seconds 1
            $retries++
            if (Test-PortListening 5173) {
                Write-Host "    Frontend online on http://localhost:5173." -ForegroundColor Green
                $webRunning = $true
                break
            }
        }

        if (-not $webRunning) {
            Write-Host "    [WARNING] Frontend did not become ready within $maxRetries seconds." -ForegroundColor Yellow
            Write-Host "              Check the JARVIS-UI terminal window for errors." -ForegroundColor DarkGray
        }
    }
}

# -- 3. Voice Service ----------------------------------------------------------
if ($NoVoice) {
    Write-Host "[3/3] Voice service skipped (-NoVoice)." -ForegroundColor DarkGray
} else {
    Write-Host "[3/3] Checking background voice service..." -ForegroundColor White
    $voiceLauncher = Join-Path $voiceDir "start-voice.ps1"
    if (Test-Path $voiceLauncher) {
        & $voiceLauncher
    } else {
        Write-Host "    Voice service launcher not found at $voiceLauncher." -ForegroundColor Yellow
    }
}

# -- Open Dashboard ------------------------------------------------------------
if (-not $Background -and -not $NoBrowser) {
    Start-Sleep -Seconds 1
    Write-Host ""
    Write-Host "  Opening dashboard at http://localhost:5173..." -ForegroundColor Cyan
    Start-Process "http://localhost:5173"
}

Write-Host ""
Write-Host "  JARVIS is ready." -ForegroundColor Green
if (-not $NoVoice) {
    Write-Host "  Voice:  Always-on wake word active. Say 'Hey JARVIS' or 'JARVIS' at any time." -ForegroundColor Cyan
}
Write-Host "  Status: .\scripts\manage-jarvis.ps1 -Action status" -ForegroundColor DarkGray
Write-Host "  Stop:   .\scripts\manage-jarvis.ps1 -Action stop" -ForegroundColor DarkGray
Write-Host ""
