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
#   logs            - Open the voice service log
#   enable-startup  - Register JARVIS for automatic Windows startup (requires approval)
#   disable-startup - Remove JARVIS from Windows startup
#   check-startup   - Check whether startup is configured

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("start","stop","restart","status","start-voice","stop-voice","logs","enable-startup","disable-startup","check-startup")]
    [string]$Action
)

$rootDir    = "D:\Sigma batch\Jarvis"
$apiDir     = "$rootDir\services\api"
$webDir     = "$rootDir\apps\web"
$voiceDir   = "$rootDir\services\voice"
$taskName   = "JARVIS-AI-Assistant"

# ── Helper ─────────────────────────────────────────────────────────────────
function Write-Step { param($msg) Write-Host "[JARVIS] $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "[OK] $msg"     -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[WARN] $msg"   -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "[ERR] $msg"    -ForegroundColor Red }

function Test-Port {
    param($port)
    try {
        $c = New-Object System.Net.Sockets.TcpClient("127.0.0.1", $port)
        $c.Close()
        return $true
    } catch { return $false }
}

# ── Start ──────────────────────────────────────────────────────────────────
function Start-Jarvis {
    Write-Step "Starting JARVIS backend..."
    Start-Process -FilePath "cmd.exe" `
        -ArgumentList '/k', "cd /d `"$apiDir`" && node src/server.js" `
        -WorkingDirectory $apiDir

    Start-Sleep -Seconds 3

    Write-Step "Starting JARVIS frontend..."
    Start-Process -FilePath "cmd.exe" `
        -ArgumentList '/k', "cd /d `"$webDir`" && npm run dev -- --host 127.0.0.1" `
        -WorkingDirectory $webDir

    Start-Sleep -Seconds 4

    if (Test-Port 3000) { Write-OK "API is online at http://127.0.0.1:3000" }
    else { Write-Warn "API may still be starting." }

    Write-Step "Opening dashboard..."
    Start-Process "http://localhost:5173"
}

# ── Stop ───────────────────────────────────────────────────────────────────
function Stop-Jarvis {
    Write-Step "Stopping JARVIS services..."

    # Stop voice service first.
    & "$voiceDir\stop-voice.ps1" -ErrorAction SilentlyContinue

    # Kill node processes running server.js or vite.
    Get-Process node -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowTitle -match "jarvis|vite" -or
        (Get-WmiObject Win32_Process | Where-Object { $_.ProcessId -eq $_.Id }).CommandLine -match "server\.js|vite"
    } | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }

    Write-OK "Services stopped."
}

# ── Status ─────────────────────────────────────────────────────────────────
function Show-Status {
    Write-Step "JARVIS Service Status"
    Write-Host ""

    # API
    $apiOnline = Test-Port 3000
    $apiStatus = if ($apiOnline) { "ONLINE  (http://127.0.0.1:3000)" } else { "OFFLINE" }
    $apiColor  = if ($apiOnline) { "Green" } else { "Red" }
    Write-Host "  API Backend:   " -NoNewline; Write-Host $apiStatus -ForegroundColor $apiColor

    # Frontend
    $webOnline = Test-Port 5173
    $webStatus = if ($webOnline) { "ONLINE  (http://localhost:5173)" } else { "OFFLINE" }
    $webColor  = if ($webOnline) { "Green" } else { "Red" }
    Write-Host "  Frontend:      " -NoNewline; Write-Host $webStatus -ForegroundColor $webColor

    # Voice service PID
    $voicePidFile = "$voiceDir\jarvis-voice.pid"
    if (Test-Path $voicePidFile) {
        $vpid = Get-Content $voicePidFile -ErrorAction SilentlyContinue
        $vproc = if ($vpid) { Get-Process -Id $vpid -ErrorAction SilentlyContinue } else { $null }
        if ($vproc) {
            Write-Host "  Voice Service: " -NoNewline; Write-Host "ONLINE  (PID $vpid)" -ForegroundColor Green
        } else {
            Write-Host "  Voice Service: " -NoNewline; Write-Host "OFFLINE (stale PID file)" -ForegroundColor Red
        }
    } else {
        Write-Host "  Voice Service: " -NoNewline; Write-Host "OFFLINE" -ForegroundColor Red
    }

    # Startup task
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $startupStatus = if ($task) { "ENABLED (Task Scheduler)" } else { "DISABLED" }
    $startupColor  = if ($task) { "Green" } else { "DarkGray" }
    Write-Host "  Auto-Startup:  " -NoNewline; Write-Host $startupStatus -ForegroundColor $startupColor

    Write-Host ""
}

# ── Enable Startup ─────────────────────────────────────────────────────────
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

    $startScript = "$rootDir\start-jarvis-background.ps1"

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
"@ | Out-File -FilePath $startScript -Encoding utf8

    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NonInteractive -WindowStyle Hidden -File `"$startScript`""
    $trigger = New-ScheduledTaskTrigger -AtLogon
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew

    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
        Write-OK "Startup task '$taskName' registered successfully."
        Write-Host "  JARVIS will start automatically after your next login." -ForegroundColor DarkGray
        Write-Host "  Disable:  .\manage-jarvis.ps1 -Action disable-startup" -ForegroundColor DarkGray
    } catch {
        Write-Err "Failed to register startup task: $_"
        Write-Host "  Try running PowerShell as Administrator." -ForegroundColor Yellow
    }
}

# ── Disable Startup ────────────────────────────────────────────────────────
function Disable-Startup {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Warn "Startup task '$taskName' is not registered."
        exit 0
    }

    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-OK "Startup task '$taskName' removed. JARVIS will no longer start automatically."
}

# ── Check Startup ──────────────────────────────────────────────────────────
function Check-Startup {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-OK "Startup task is ENABLED."
        Write-Host "  Name:    $taskName"
        Write-Host "  State:   $($task.State)"
        Write-Host "  Trigger: At log on"
    } else {
        Write-Warn "No startup task registered."
        Write-Host "  To enable: .\manage-jarvis.ps1 -Action enable-startup"
    }
}

# ── Open Logs ─────────────────────────────────────────────────────────────
function Open-Logs {
    $logFile = "$voiceDir\logs\jarvis-voice.log"
    if (Test-Path $logFile) {
        notepad.exe $logFile
    } else {
        Write-Warn "No log file found at: $logFile"
        Write-Host "Start the voice service first." -ForegroundColor DarkGray
    }
}

# ── Dispatch ────────────────────────────────────────────────────────────────
switch ($Action) {
    "start"           { Start-Jarvis }
    "stop"            { Stop-Jarvis }
    "restart"         { Stop-Jarvis; Start-Sleep -Seconds 2; Start-Jarvis }
    "status"          { Show-Status }
    "start-voice"     { & "$voiceDir\start-voice.ps1" }
    "stop-voice"      { & "$voiceDir\stop-voice.ps1" }
    "logs"            { Open-Logs }
    "enable-startup"  { Enable-Startup }
    "disable-startup" { Disable-Startup }
    "check-startup"   { Check-Startup }
}
