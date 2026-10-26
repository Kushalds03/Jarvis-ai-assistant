# JARVIS Master Management Script
# Usage: .\manage-jarvis.ps1 -Action <action>
#
# Actions:
#   start           - Start the API backend and frontend
#   stop            - Stop all JARVIS processes
#   restart         - Restart all services
#   status          - Show service status
#   start-voice     - Start the background voice service
#   stop-voice      - Stop the background voice service
#   pause-voice     - Pause wake-word listening
#   resume-voice    - Resume wake-word listening
#   mute-voice      - Mute spoken responses
#   unmute-voice    - Unmute spoken responses
#   logs            - Open the voice service log
#   enable-startup  - Register JARVIS for automatic Windows startup (requires approval)
#   disable-startup - Remove JARVIS from Windows startup
#   check-startup   - Check whether startup is configured

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("start","stop","restart","status","start-voice","stop-voice","pause-voice","resume-voice","mute-voice","unmute-voice","logs","enable-startup","disable-startup","check-startup")]
    [string]$Action
)

$rootDir = Split-Path -Parent $PSScriptRoot
if (-not $rootDir) { $rootDir = "D:\Sigma batch\Jarvis" }
$apiDir     = Join-Path $rootDir "services\api"
$webDir     = Join-Path $rootDir "apps\web"
$voiceDir   = Join-Path $rootDir "services\voice"
$taskName   = "JARVIS-AI-Assistant"

# -- Helpers -----------------------------------------------------------------
function Write-Step { param($msg) Write-Host "[JARVIS] $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "[OK] $msg"     -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[WARN] $msg"   -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "[ERR] $msg"    -ForegroundColor Red }

function Test-Port {
    param([int]$port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $client.BeginConnect("127.0.0.1", $port, $null, $null)
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

# -- Start -------------------------------------------------------------------
function Start-Jarvis {
    Write-Step "Checking port 3000..."
    if (Test-Port 3000) {
        Write-Warn "Port 3000 is already in use."
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 3
            Write-OK "API backend is already online (Provider: $($health.provider))."
        } catch {
            Write-Warn "Port 3000 is occupied but not responding as JARVIS API."
        }
    } else {
        Write-Step "Starting JARVIS backend..."
        Start-Process -FilePath "cmd.exe" `
            -ArgumentList '/k', "title JARVIS-API & node src/server.js" `
            -WorkingDirectory $apiDir
        Start-Sleep -Seconds 3
    }

    Write-Step "Checking port 5173..."
    if (Test-Port 5173) {
        Write-OK "Frontend is already running on port 5173."
    } else {
        Write-Step "Starting JARVIS frontend..."
        Start-Process -FilePath "cmd.exe" `
            -ArgumentList '/k', "title JARVIS-UI & npm run dev -- --host 127.0.0.1" `
            -WorkingDirectory $webDir
        Start-Sleep -Seconds 4
    }

    if (Test-Port 3000) { Write-OK "API is online at http://127.0.0.1:3000" }
    else { Write-Warn "API may still be starting." }

    Write-Step "Opening dashboard..."
    Start-Process "http://localhost:5173"
}

# -- Stop --------------------------------------------------------------------
function Stop-Jarvis {
    Write-Step "Stopping JARVIS services..."

    # Stop voice service first.
    $stopVoiceScript = Join-Path $voiceDir "stop-voice.ps1"
    if (Test-Path $stopVoiceScript) {
        & $stopVoiceScript
    }

    # Stop node processes that specifically belong to JARVIS
    $nodeProcesses = Get-Process node -ErrorAction SilentlyContinue
    foreach ($proc in $nodeProcesses) {
        $cmdLine = $null
        try {
            $wmi = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue
            if ($wmi) { $cmdLine = $wmi.CommandLine }
        } catch {}

        $isJarvis = ($proc.MainWindowTitle -match "JARVIS") -or 
                    ($cmdLine -and ($cmdLine -match "server\.js" -or $cmdLine -match "vite"))

        if ($isJarvis) {
            Write-Step "Stopping Node process PID $($proc.Id)..."
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }

    # Stop any lingering cmd windows titled JARVIS
    Get-Process cmd -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowTitle -match "JARVIS-API|JARVIS-UI"
    } | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }

    Write-OK "Services stopped."
}

# -- Status ------------------------------------------------------------------
function Show-Status {
    Write-Step "JARVIS Service Status"
    Write-Host ""

    # API
    $apiOnline = Test-Port 3000
    $providerInfo = ""
    if ($apiOnline) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 2
            $providerInfo = " [Provider: $($health.provider)]"
        } catch {}
    }
    $apiStatus = if ($apiOnline) { "ONLINE  (http://127.0.0.1:3000)$providerInfo" } else { "OFFLINE" }
    $apiColor  = if ($apiOnline) { "Green" } else { "Red" }
    Write-Host "  API Backend:   " -NoNewline; Write-Host $apiStatus -ForegroundColor $apiColor

    # Frontend
    $webOnline = Test-Port 5173
    $webStatus = if ($webOnline) { "ONLINE  (http://localhost:5173)" } else { "OFFLINE" }
    $webColor  = if ($webOnline) { "Green" } else { "Red" }
    Write-Host "  Frontend:      " -NoNewline; Write-Host $webStatus -ForegroundColor $webColor

    # Voice service
    $voicePidFile = Join-Path $voiceDir "jarvis-voice.pid"
    $voiceDetail = "OFFLINE"
    $voiceColor  = "Red"

    if (Test-Path $voicePidFile) {
        $vpid = Get-Content $voicePidFile -ErrorAction SilentlyContinue
        $vproc = if ($vpid) { Get-Process -Id $vpid -ErrorAction SilentlyContinue } else { $null }
        if ($vproc -and $vproc.ProcessName -match "python") {
            $voiceDetail = "ONLINE  (PID $vpid)"
            $voiceColor  = "Green"
            if ($apiOnline) {
                try {
                    $vs = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/voice/status" -TimeoutSec 1
                    if ($vs.online) {
                        $voiceDetail = "ONLINE  (PID $vpid, Status: $($vs.status.ToUpper()))"
                    }
                } catch {}
            }
        } else {
            $voiceDetail = "OFFLINE (stale PID file)"
        }
    }
    Write-Host "  Voice Service: " -NoNewline; Write-Host $voiceDetail -ForegroundColor $voiceColor

    # Startup task
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $startupStatus = if ($task) { "ENABLED (Task Scheduler)" } else { "DISABLED" }
    $startupColor  = if ($task) { "Green" } else { "DarkGray" }
    Write-Host "  Auto-Startup:  " -NoNewline; Write-Host $startupStatus -ForegroundColor $startupColor

    Write-Host ""
}

# -- Enable Startup ----------------------------------------------------------
function Enable-Startup {
    Write-Step "Windows Startup Setup"
    Write-Host ""
    Write-Warn "This will register a Windows Task Scheduler task named '$taskName'."
    Write-Warn "JARVIS will start automatically when you log in to Windows."
    Write-Warn "No browser will open automatically."
    Write-Host ""

    $confirm = Read-Host "Proceed? (yes/no)"
    if ($confirm -ne "yes") {
        Write-Host "Startup registration cancelled." -ForegroundColor Yellow
        exit 0
    }

    $startScript = Join-Path $rootDir "start-jarvis-background.ps1"

    # Create a startup script that runs API + voice service in background.
    @"
# JARVIS Auto-Start (generated by manage-jarvis.ps1)
# Starts only the API backend and voice service (no browser).
`$apiDir   = '$apiDir'
`$voiceDir = '$voiceDir'

# Wait for desktop to be ready.
Start-Sleep -Seconds 5

# Start API backend hidden.
Start-Process -FilePath 'node' ``
    -ArgumentList 'src/server.js' ``
    -WorkingDirectory `$apiDir ``
    -WindowStyle Hidden

Start-Sleep -Seconds 4

# Start voice service.
Start-Process -FilePath 'powershell.exe' ``
    -ArgumentList '-NonInteractive', '-File', "`$voiceDir\start-voice.ps1" ``
    -WindowStyle Hidden
"@ | Out-File -FilePath $startScript -Encoding ascii

    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NonInteractive -WindowStyle Hidden -File `"$startScript`""
    $trigger = New-ScheduledTaskTrigger -AtLogon
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew

    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
        Write-OK "Startup task '$taskName' registered successfully."
        Write-Host "  JARVIS will start automatically after your next login." -ForegroundColor DarkGray
        Write-Host "  Disable:  .\scripts\manage-jarvis.ps1 -Action disable-startup" -ForegroundColor DarkGray
    } catch {
        Write-Err "Failed to register startup task: $_"
        Write-Host "  Try running PowerShell as Administrator." -ForegroundColor Yellow
    }
}

# -- Disable Startup ---------------------------------------------------------
function Disable-Startup {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Warn "Startup task '$taskName' is not registered."
        exit 0
    }

    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-OK "Startup task '$taskName' removed. JARVIS will no longer start automatically."
}

# -- Check Startup -----------------------------------------------------------
function Check-Startup {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-OK "Startup task is ENABLED."
        Write-Host "  Name:    $taskName"
        Write-Host "  State:   $($task.State)"
        Write-Host "  Trigger: At log on"
    } else {
        Write-Warn "No startup task registered."
        Write-Host "  To enable: .\scripts\manage-jarvis.ps1 -Action enable-startup"
    }
}

# -- Open Logs --------------------------------------------------------------
function Open-Logs {
    $logFile = Join-Path $voiceDir "logs\jarvis-voice.log"
    if (Test-Path $logFile) {
        notepad.exe $logFile
    } else {
        Write-Warn "No log file found at: $logFile"
        Write-Host "Start the voice service first." -ForegroundColor DarkGray
    }
}

# -- Dispatch ----------------------------------------------------------------
switch ($Action) {
    "start"           { Start-Jarvis }
    "stop"            { Stop-Jarvis }
    "restart"         { Stop-Jarvis; Start-Sleep -Seconds 2; Start-Jarvis }
    "status"          { Show-Status }
    "start-voice"     { & (Join-Path $voiceDir "start-voice.ps1") }
    "stop-voice"      { & (Join-Path $voiceDir "stop-voice.ps1") }
    "pause-voice"     { & (Join-Path $voiceDir "control-voice.ps1") -Command pause }
    "resume-voice"    { & (Join-Path $voiceDir "control-voice.ps1") -Command resume }
    "mute-voice"      { & (Join-Path $voiceDir "control-voice.ps1") -Command mute }
    "unmute-voice"    { & (Join-Path $voiceDir "control-voice.ps1") -Command unmute }
    "logs"            { Open-Logs }
    "enable-startup"  { Enable-Startup }
    "disable-startup" { Disable-Startup }
    "check-startup"   { Check-Startup }
}
