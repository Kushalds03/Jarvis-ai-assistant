# JARVIS Voice Service Launcher
# Starts the Python background voice service.
# Run from any directory.

$serviceDir = $PSScriptRoot
if (-not $serviceDir) { $serviceDir = "D:\Sigma batch\Jarvis\services\voice" }
$pidFile    = Join-Path $serviceDir "jarvis-voice.pid"
$logDir     = Join-Path $serviceDir "logs"
$script     = Join-Path $serviceDir "jarvis_voice.py"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# -- Check for existing process ---------------------------------------------
if (Test-Path $pidFile) {
    $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existingPid) {
        $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match "python") {
            Write-Host "[JARVIS Voice] Already running (PID $existingPid). Use stop-voice.ps1 first." -ForegroundColor Yellow
            exit 0
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# -- Verify Python -----------------------------------------------------------
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
$python = if ($pythonCmd) { $pythonCmd.Source } else { $null }
if (-not $python) {
    Write-Host "[ERROR] Python not found. Install Python 3.12+ and add it to PATH." -ForegroundColor Red
    exit 1
}

# Use python with WindowStyle Hidden (ensures full standard IO and COM initialization for SAPI and PyAudio)
$launchExe = $python

# -- Verify required Python packages -----------------------------------------
$checkScript = "import sys; pkgs=['speech_recognition','pyttsx3','requests','pyaudio','openwakeword','onnxruntime','numpy','psutil']; missing=[p for p in pkgs if __import__('importlib.util').util.find_spec(p) is None]; sys.exit(1 if missing else 0)"
$checkProc = Start-Process -FilePath $python -ArgumentList "-c `"$checkScript`"" -NoNewWindow -Wait -PassThru
if ($checkProc.ExitCode -ne 0) {
    Write-Host "[WARNING] One or more voice packages are missing." -ForegroundColor Yellow
    Write-Host "          Run: pip install -r `"$serviceDir\requirements.txt`"" -ForegroundColor DarkGray
    exit 1
}

# -- Verify JARVIS API is reachable ----------------------------------------
try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 3
} catch {
    Write-Host "[WARNING] JARVIS API is not responding at port 3000." -ForegroundColor Yellow
    Write-Host "          The voice service will keep retrying automatically." -ForegroundColor DarkGray
}

# -- Start the voice service in the background ------------------------------
Write-Host "[JARVIS Voice] Starting background voice service..." -ForegroundColor Cyan

$mainLog = Join-Path $logDir "jarvis-voice.log"
$errFile = Join-Path $logDir "jarvis-voice-err.log"

$proc = Start-Process `
    -FilePath $launchExe `
    -ArgumentList "`"$script`"" `
    -WorkingDirectory $serviceDir `
    -WindowStyle Hidden `
    -PassThru

if ($proc) {
    $proc.Id | Out-File -FilePath $pidFile -Encoding ascii
    Write-Host "[JARVIS Voice] Process launched (PID $($proc.Id)). Verifying initialization..." -ForegroundColor Cyan

    $ready = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        $checkProc = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if (-not $checkProc) {
            Write-Host "[ERROR] Voice service process exited unexpectedly. Check logs:" -ForegroundColor Red
            if (Test-Path $errFile) {
                Get-Content $errFile -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
            }
            if (Test-Path $mainLog) {
                Get-Content $mainLog -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
            }
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
            exit 1
        }

        try {
            $status = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/voice/status" -TimeoutSec 1
            if ($status.online -and ($status.status -eq "listening" -or $status.wakeWordActive)) {
                $ready = $true
                break
            }
        } catch {}
    }

    if ($ready) {
        Write-Host "[JARVIS Voice] Service is online and actively listening for 'Hey JARVIS'." -ForegroundColor Green
    } else {
        Write-Host "[JARVIS Voice] Running with PID $($proc.Id). Microphone initialized." -ForegroundColor Green
    }
    Write-Host "               Log:   $mainLog" -ForegroundColor DarkGray
    Write-Host "               Stop:  .\services\voice\stop-voice.ps1" -ForegroundColor DarkGray
    Write-Host "               Pause: .\services\voice\control-voice.ps1 -Command pause" -ForegroundColor DarkGray
} else {
    Write-Host "[ERROR] Failed to start the voice service." -ForegroundColor Red
    exit 1
}
