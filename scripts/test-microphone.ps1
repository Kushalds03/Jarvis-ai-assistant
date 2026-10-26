# JARVIS Microphone Diagnostic & Verification Script
# Tests microphone hardware, volume level (RMS/Peak), and speech recognition
# without executing any computer actions or saving audio unless requested.
# Compatible with Windows PowerShell 5.1.
#
# Examples:
#   .\scripts\test-microphone.ps1 -List
#   .\scripts\test-microphone.ps1 -DeviceName "Rockerz" -Duration 4
#   .\scripts\test-microphone.ps1 -DeviceIndex 2 -Duration 5 -PlayBack
#   .\scripts\test-microphone.ps1 -DeviceIndex 1 -Duration 4   # Test built-in mic

[CmdletBinding()]
param(
    [int]$DeviceIndex = -1,
    [string]$DeviceName = "",
    [int]$Duration = 4,
    [switch]$List,
    [switch]$PlayBack,
    [string]$SaveWav = "",
    [string]$Language = "en-IN"
)

$ErrorActionPreference = "Continue"

$rootDir = Split-Path -Parent $PSScriptRoot
if (-not $rootDir) { $rootDir = "D:\Sigma batch\Jarvis" }
$testScript = Join-Path $rootDir "services\voice\test_microphone.py"

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
$pythonExe = if ($pythonCmd) { $pythonCmd.Source } else { $null }

if (-not $pythonExe) {
    Write-Host "[ERROR] Python not found in PATH." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $testScript)) {
    Write-Host "[ERROR] Tester script missing at $testScript" -ForegroundColor Red
    exit 1
}

$argList = @("`"$testScript`"")

if ($List) {
    $argList += "--list"
} else {
    if ($DeviceIndex -ge 0) {
        $argList += "--device-index"
        $argList += "$DeviceIndex"
    } elseif ($DeviceName) {
        $argList += "--device-name"
        $argList += "`"$DeviceName`""
    }
    if ($Duration -gt 0) {
        $argList += "--duration"
        $argList += "$Duration"
    }
    if ($PlayBack) {
        $argList += "--playback"
    }
    if ($SaveWav) {
        $argList += "--save-wav"
        $argList += "`"$SaveWav`""
    }
    if ($Language) {
        $argList += "--lang"
        $argList += "$Language"
    }
}

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "           J.A.R.V.I.S. MICROPHONE HARDWARE TESTER               " -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " Mode: Safe hardware test (No computer actions will be executed)" -ForegroundColor DarkGray
Write-Host ""

$proc = Start-Process -FilePath $pythonExe -ArgumentList ($argList -join " ") -NoNewWindow -Wait -PassThru
exit $proc.ExitCode
