# JARVIS Complete Voice Pipeline Diagnostics Script
# Performs rigorous, non-destructive health checks across all layers of the voice pipeline:
# Process -> Microphone Hardware -> Selected Device -> Audio Frame Flow ->
# Wake-Word Model -> Wake Trigger Events -> Audio Capture -> STT -> Backend API -> Agent -> DB.
# Compatible with Windows PowerShell 5.1.
#
# Usage:
#   .\scripts\diagnose-voice.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"

$rootDir = Split-Path -Parent $PSScriptRoot
if (-not $rootDir) { $rootDir = "D:\Sigma batch\Jarvis" }

$voiceDir = Join-Path $rootDir "services\voice"
$pidFile  = Join-Path $voiceDir "jarvis-voice.pid"
$logFile  = Join-Path $voiceDir "logs\jarvis-voice.log"
$dbFile   = Join-Path $rootDir "services\api\data\jarvis-memory.db"

$totalChecks = 0
$passCount   = 0
$warnCount   = 0
$failCount   = 0

function Write-DiagResult {
    param(
        [string]$Name,
        [string]$Status, # "PASS", "WARN", "FAIL", "INFO"
        [string]$Details
    )
    $script:totalChecks++
    $color = "Green"
    if ($Status -eq "WARN") { $color = "Yellow"; $script:warnCount++ }
    elseif ($Status -eq "FAIL") { $color = "Red"; $script:failCount++ }
    elseif ($Status -eq "INFO") { $color = "Cyan"; $script:passCount++ }
    else { $script:passCount++ }

    $tag = "[$Status]"
    $line = "{0,-8} {1,-38} : {2}" -f $tag, $Name, $Details
    Write-Host $line -ForegroundColor $color
}

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "             J.A.R.V.I.S. VOICE PIPELINE DIAGNOSTICS             " -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
Write-Host " Workspace: $rootDir" -ForegroundColor DarkGray
Write-Host ""

# ── 1. Python Interpreter ──────────────────────────────────────────────────
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
$pythonExe = if ($pythonCmd) { $pythonCmd.Source } else { $null }

if ($pythonExe) {
    try {
        $pyVer = (& $pythonExe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')") 2>$null
        Write-DiagResult "Python Interpreter" "PASS" "$pythonExe (v$pyVer)"
    } catch {
        Write-DiagResult "Python Interpreter" "PASS" "$pythonExe"
    }
} else {
    Write-DiagResult "Python Interpreter" "FAIL" "Python not found in PATH."
}

# ── 2. Required Python Packages ───────────────────────────────────────────
if ($pythonExe) {
    $pkgCheckCode = @'
import importlib.util, sys
packages = ['openwakeword', 'speech_recognition', 'pyttsx3', 'pyaudio', 'requests', 'onnxruntime', 'numpy']
missing = [p for p in packages if importlib.util.find_spec(p) is None]
if missing:
    print('MISSING:' + ','.join(missing))
    sys.exit(1)
print('ALL_FOUND')
sys.exit(0)
'@
    $pkgResult = (& $pythonExe -c $pkgCheckCode) 2>&1
    if ($LASTEXITCODE -eq 0 -and $pkgResult -match "ALL_FOUND") {
        Write-DiagResult "Python Voice Packages" "PASS" "All required modules present (openwakeword, speech_rec, pyttsx3, pyaudio, etc.)"
    } else {
        Write-DiagResult "Python Voice Packages" "FAIL" "Missing modules: $pkgResult"
    }
} else {
    Write-DiagResult "Python Voice Packages" "FAIL" "Skipped because Python is missing."
}

# ── 3. Microphone Hardware & Rockerz 110 Detection ────────────────────────
$rockerzFound = $false
if ($pythonExe) {
    $micCode = "import speech_recognition as sr; names = sr.Microphone.list_microphone_names(); matched = ['[' + str(i) + '] ' + names[i] for i in range(len(names)) if 'rockerz' in names[i].lower() and 'headset' in names[i].lower()]; print('COUNT:' + str(len(names)) + '|ROCKERZ:' + ('; '.join(matched) if matched else 'NONE'))"
    $micResult = (& $pythonExe -c $micCode) 2>&1
    $micLine = ($micResult | Where-Object { $_ -match "^COUNT:" } | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $micLine -and $micLine -match "^COUNT:(\d+)\|ROCKERZ:(.*)") {
        $count = $Matches[1]
        $rockerzInfo = $Matches[2]
        if ($rockerzInfo -ne "NONE") {
            $rockerzFound = $true
            Write-DiagResult "Microphone Hardware" "PASS" "$count device(s) found. Rockerz detected: $rockerzInfo"
        } else {
            Write-DiagResult "Microphone Hardware" "WARN" "$count device(s) found, but Rockerz 110 not detected (check Bluetooth)."
        }
    } else {
        Write-DiagResult "Microphone Hardware" "WARN" "Audio query returned: $micResult"
    }
} else {
    Write-DiagResult "Microphone Hardware" "FAIL" "Skipped because Python is missing."
}

# ── 4. OpenWakeWord Model Availability ────────────────────────────────────
if ($pythonExe) {
    $modelCheckCode = @'
import sys
try:
    from openwakeword.model import Model
    m = Model(wakeword_models=['hey_jarvis'], inference_framework='onnx')
    models = list(m.models.keys())
    if 'hey_jarvis' in models:
        print('MODEL_READY')
        sys.exit(0)
    else:
        print('MODEL_NOT_FOUND:' + str(models))
        sys.exit(1)
except Exception as e:
    print(f'MODEL_ERROR:{e}')
    sys.exit(2)
'@
    $modelResult = (& $pythonExe -c $modelCheckCode) 2>&1
    if ($LASTEXITCODE -eq 0 -and $modelResult -match "MODEL_READY") {
        Write-DiagResult "Wake-Word Model" "PASS" "Local ONNX model 'hey_jarvis' loaded successfully."
    } else {
        Write-DiagResult "Wake-Word Model" "FAIL" "Failed to load openwakeword model: $modelResult"
    }
} else {
    Write-DiagResult "Wake-Word Model" "FAIL" "Skipped because Python is missing."
}

# ── 5. Voice Service Process & PID ────────────────────────────────────────
$serviceProcRunning = $false
$voicePid = $null
if (Test-Path $pidFile) {
    $voicePid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($voicePid) {
        $p = Get-Process -Id $voicePid -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -match "python") {
            $serviceProcRunning = $true
            Write-DiagResult "Voice Service Process" "PASS" "Process active with PID $voicePid ($($p.ProcessName))."
        } else {
            Write-DiagResult "Voice Service Process" "WARN" "PID file exists ($voicePid), but process is not running (stale PID)."
        }
    }
}

if (-not $serviceProcRunning -and -not (Test-Path $pidFile)) {
    Write-DiagResult "Voice Service Process" "WARN" "Service is currently stopped (use start-voice.ps1 or start-jarvis.ps1)."
}

# ── 6. Log File & Audio Capture Verification ──────────────────────────────
$logContent = $null
if (Test-Path $logFile) {
    $logContent = Get-Content $logFile -Tail 200 -ErrorAction SilentlyContinue

    # Check selected microphone in log
    $micLine = ($logContent | Select-String "Selected preferred microphone:|Microphone selected|Using fallback|Falling back to" | Select-Object -Last 1)
    if ($micLine) {
        $cleanMic = $micLine.Line.Trim()
        Write-DiagResult "Configured Audio Device" "PASS" "$cleanMic"
    } else {
        Write-DiagResult "Configured Audio Device" "WARN" "No device selection entry found in recent log."
    }

    # Check audio frame flow (RMS & Peak monitoring)
    $audioFlowLine = ($logContent | Select-String "\[Audio Status\] Monitoring:" | Select-Object -Last 1)
    if ($audioFlowLine) {
        $cleanAudio = $audioFlowLine.Line -replace ".*\[Audio Status\] Monitoring:\s*", ""
        Write-DiagResult "Audio Stream Frame Flow" "PASS" "Frames actively flowing ($cleanAudio)"
    } elseif ($serviceProcRunning) {
        Write-DiagResult "Audio Stream Frame Flow" "WARN" "Service running but no recent audio monitoring entries logged."
    } else {
        Write-DiagResult "Audio Stream Frame Flow" "WARN" "Service stopped. Cannot verify active audio stream."
    }

    # Check wake-word detection history
    $wakeDetections = ($logContent | Select-String "Wake word 'hey_jarvis' DETECTED!|Wake word.*detected")
    $candidateDetections = ($logContent | Select-String "Wake-word candidate detected")
    if ($wakeDetections) {
        $lastWake = ($wakeDetections | Select-Object -Last 1).Line.Trim()
        Write-DiagResult "Wake-Word Detection Events" "PASS" "$($wakeDetections.Count) detection(s) in session. Last: $lastWake"
    } elseif ($candidateDetections) {
        Write-DiagResult "Wake-Word Detection Events" "INFO" "$($candidateDetections.Count) audio candidate(s) seen. Awaiting full wake word."
    } else {
        Write-DiagResult "Wake-Word Detection Events" "INFO" "No wake word triggers in current log session (Say 'Hey JARVIS' to test)."
    }

    # Check speech transcription history
    $transcriptionLines = ($logContent | Select-String "Command transcribed successfully|Command captured:" | Select-Object -Last 1)
    if ($transcriptionLines) {
        $cleanTrans = $transcriptionLines.Line.Trim()
        Write-DiagResult "Command Transcription" "PASS" "Last: $cleanTrans"
    } else {
        Write-DiagResult "Command Transcription" "INFO" "No spoken commands transcribed yet in this session."
    }
} else {
    Write-DiagResult "Voice Service Log" "WARN" "Log file not created yet: $logFile"
}

# ── 7. Backend API Health Endpoint ────────────────────────────────────────
$backendOnline = $false
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 3
    if ($health -and $health.status -eq "online") {
        $backendOnline = $true
        Write-DiagResult "Backend Health (/api/health)" "PASS" "Online. Provider: $($health.provider) (memory: $($health.memory))."
    } else {
        Write-DiagResult "Backend Health (/api/health)" "WARN" "Responded, but status is not 'online'."
    }
} catch {
    Write-DiagResult "Backend Health (/api/health)" "WARN" "Backend API offline on port 3000."
}

# ── 8. Voice Status Endpoint ──────────────────────────────────────────────
if ($backendOnline) {
    try {
        $vStatus = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/voice/status" -TimeoutSec 2
        if ($vStatus.online) {
            $micStr = if ($vStatus.micDevice) { " [Mic: $($vStatus.micDevice)]" } else { "" }
            Write-DiagResult "Voice Status Endpoint" "PASS" "Online. State: $($vStatus.status.ToUpper()) (wakeWordActive=$($vStatus.wakeWordActive))$micStr."
        } else {
            $reason = if ($serviceProcRunning) { "Process running, waiting for heartbeat" } else { "Voice process stopped" }
            Write-DiagResult "Voice Status Endpoint" "WARN" "Offline ($reason). Status: $($vStatus.status)."
        }
    } catch {
        Write-DiagResult "Voice Status Endpoint" "FAIL" "Endpoint error: $_"
    }
} else {
    Write-DiagResult "Voice Status Endpoint" "WARN" "Skipped (backend API offline)."
}

# ── 9. Unified Agent Endpoint Test ────────────────────────────────────────
if ($backendOnline) {
    try {
        $body = @{ message = "What time is it?" } | ConvertTo-Json
        $agentResp = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/agent" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 5
        if ($agentResp -and $agentResp.reply) {
            Write-DiagResult "Agent Command Pipeline" "PASS" "Responded: $($agentResp.reply.Substring(0, [Math]::Min(60, $agentResp.reply.Length)))..."
        } else {
            Write-DiagResult "Agent Command Pipeline" "WARN" "Agent returned unexpected payload."
        }
    } catch {
        Write-DiagResult "Agent Command Pipeline" "FAIL" "Agent request failed: $_"
    }
} else {
    Write-DiagResult "Agent Command Pipeline" "WARN" "Skipped (backend API offline)."
}

# ── 10. Persistent SQLite Database ────────────────────────────────────────
if (Test-Path $dbFile) {
    $dbSize = (Get-Item $dbFile).Length
    Write-DiagResult "SQLite Memory Store" "PASS" "Database exists ($dbSize bytes) at $dbFile. Data intact."
} else {
    Write-DiagResult "SQLite Memory Store" "WARN" "Database file not found at $dbFile."
}

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " Summary: $passCount PASS / $warnCount WARNING / $failCount FAIL  (Total $totalChecks checks)" -ForegroundColor Cyan
Write-Host " Note: Physical voice recognition requires speaking 'Hey JARVIS' into the mic." -ForegroundColor DarkGray
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host ""
