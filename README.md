# J.A.R.V.I.S. — Personal AI Agent

> **Just A Rather Very Intelligent System**
> A voice-controlled personal AI assistant for Windows, inspired by Iron Man.

![Build](https://img.shields.io/badge/build-passing-green)
![Version](https://img.shields.io/badge/version-0.5.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%2011-blue)

---

## What JARVIS Does

- **Voice-activated**: Say "Hey JARVIS" to wake it up, then give natural-language commands.
- **Desktop automation**: Opens apps, locks PC, manages files, schedules shutdowns.
- **Git/GitHub integration**: Status, diffs, commits, pushes — all from voice.
- **AI chat**: Conversational AI using local Ollama (private) or Google Gemini.
- **Persistent memory**: Remembers facts you tell it using SQLite.
- **Task agent**: Plans and executes multi-step tasks through a validated action registry.
- **Background service**: Runs without a browser using the Python voice service.
- **Approval system**: Consequential actions (shutdown, commits, pushes) require confirmation.

---

## Architecture

```
D:\Sigma batch\Jarvis\
├── apps/web/              React 19 + TypeScript + Vite dashboard
├── services/api/          Express backend (Node.js 24)
│   └── src/
│       ├── server.js      Main API server
│       ├── memory.js      SQLite memory (better-sqlite3)
│       ├── actions/       Validated action handlers
│       │   ├── config.js  App/project configuration
│       │   ├── registry.js  Action type definitions & validation
│       │   ├── system.js  Lock, shutdown, restart
│       │   ├── apps.js    Application launcher
│       │   ├── files.js   File operations
│       │   └── git.js     Git / GitHub CLI
│       └── agent/         Task planning & execution
│           ├── planner.js   NL → structured plan
│           └── executor.js  Plan execution dispatcher
├── services/voice/        Python background voice service
│   ├── jarvis_voice.py    Main voice service
│   ├── start-voice.ps1    Start the voice service
│   └── stop-voice.ps1     Stop the voice service
├── scripts/
│   └── manage-jarvis.ps1  Master management script
├── start-jarvis.ps1       Full launcher
└── .env                   API keys (never committed)
```

---

## Requirements

| Dependency | Version | Purpose |
|---|---|---|
| Node.js | 24.x | Backend + frontend |
| Python | 3.12.x | Background voice service |
| Ollama | Latest | Local AI (qwen2.5:3b) |
| Google Chrome | Any | Browser voice recognition |

### Python packages (auto-installed)
```
SpeechRecognition, pyttsx3, requests, psutil,
openwakeword, onnxruntime, numpy, pyaudio
```

---

## First-Run Setup

### 1. Clone / open the project
```powershell
cd "D:\Sigma batch\Jarvis"
```

### 2. Install Node dependencies
```powershell
cd services\api && npm install
cd ..\..
cd apps\web && npm install
```

### 3. Install Python voice dependencies
```powershell
cd services\voice
pip install -r requirements.txt
```

### 4. Configure environment
`services/api/.env` already has your Gemini key. Never commit this file.
```env
GEMINI_API_KEY=your_key_here
```

### 5. Install and start Ollama
```powershell
# Download from https://ollama.com, then:
ollama pull qwen2.5:3b
```

### 6. Launch JARVIS
```powershell
.\start-jarvis.ps1
```

---

## Daily Usage

### Start in development mode (API + Frontend + Voice + Browser)
```powershell
.\start-jarvis.ps1
```

### Start in background assistant mode (API + Voice, headless)
```powershell
.\start-jarvis.ps1 -Background
```

### Start without voice service
```powershell
.\start-jarvis.ps1 -NoVoice
```

### Start without opening browser
```powershell
.\start-jarvis.ps1 -NoBrowser
```

### Status check
```powershell
.\scripts\manage-jarvis.ps1 -Action status
```

### Stop all services
```powershell
.\scripts\manage-jarvis.ps1 -Action stop
```

### Restart
```powershell
.\scripts\manage-jarvis.ps1 -Action restart
```

---

## Voice Commands (Examples)

| Say | JARVIS does |
|---|---|
| "Hey JARVIS" | "Yes, Sir?" → listens for command |
| "What time is it?" | Reports system time and RAM |
| "Open Chrome" | Launches Chrome via registered path |
| "Open VS Code" | Launches VS Code |
| "Lock my PC" | Locks workstation immediately |
| "Shut down my PC in 60 seconds" | Schedules shutdown with confirmation |
| "Cancel the shutdown" | Cancels any pending shutdown |
| "Check my git status" | Reports branch, changes, recent commits |
| "Open my dashboard" | Opens http://localhost:5173 |
| "Remember that I prefer dark mode" | Saves to SQLite memory |
| "What do you remember about me?" | Lists all memories |

---

## Dashboard Tabs

| Tab | Contents |
|---|---|
| **Chat** | Conversational interface, voice controls, Chat/Agent mode toggle |
| **Agent** | Quick-action buttons + custom command field |
| **Memories** | Browse, add, delete saved memories |
| **Approvals** | Pending action confirmations (shutdown, commits, pushes) |
| **Status** | Backend/voice/Git live status + system info |
| **Settings** | AI provider selection, voice config, startup instructions |

---

## AI Provider Selection

Switch between providers from the dashboard Settings tab or via API:

```bash
# Switch to Gemini
curl -X POST http://127.0.0.1:3000/api/provider \
  -H "Content-Type: application/json" \
  -d '{"provider":"gemini"}'

# Switch to local Ollama
curl -X POST http://127.0.0.1:3000/api/provider \
  -d '{"provider":"ollama"}'
```

Gemini requires `GEMINI_API_KEY` in `services/api/.env`.
If Gemini fails, JARVIS automatically falls back to Ollama.

---

## Background Voice Service

The Python voice service runs independently of the browser and starts automatically with `start-jarvis.ps1`.
It initializes the microphone immediately and listens continuously for **"Hey JARVIS"** or **"JARVIS"** without requiring any manual dashboard button.

```powershell
# Start directly
.\services\voice\start-voice.ps1

# Pause wake-word listening
.\services\voice\control-voice.ps1 -Command pause
# Or: .\scripts\manage-jarvis.ps1 -Action pause-voice

# Resume wake-word listening
.\services\voice\control-voice.ps1 -Command resume
# Or: .\scripts\manage-jarvis.ps1 -Action resume-voice

# Mute spoken responses
.\services\voice\control-voice.ps1 -Command mute
# Or: .\scripts\manage-jarvis.ps1 -Action mute-voice

# Unmute spoken responses
.\services\voice\control-voice.ps1 -Command unmute
# Or: .\scripts\manage-jarvis.ps1 -Action unmute-voice

# Stop the voice service
.\services\voice\stop-voice.ps1

# View logs
.\scripts\manage-jarvis.ps1 -Action logs
```

### Voice Lifecycle
`STARTUP -> MIC INITIALIZED -> WAKE-WORD LISTENING -> "YES, SIR?" -> COMMAND CAPTURE -> AI/AGENT EXECUTION -> SPOKEN RESPONSE -> RESUME LISTENING`

- **Automatic Wake-Word**: Uses local `openwakeword` (`hey_jarvis`), zero cloud audio streaming during monitoring.
- **Echo-Free**: Pauses microphone during speech synthesis and adds reverb delay before resuming wake-word detection.
- **Offline TTS**: Uses Windows SAPI5 via `pyttsx3`.
- **Works Without Browser**: Wake-word monitoring remains active even when the dashboard is closed.

---

## Windows Automatic Startup

> ⚠️ This requires your explicit approval each time.

```powershell
# Enable (shows confirmation prompt)
.\scripts\manage-jarvis.ps1 -Action enable-startup

# Check status
.\scripts\manage-jarvis.ps1 -Action check-startup

# Disable
.\scripts\manage-jarvis.ps1 -Action disable-startup
```

Startup runs the API backend + voice service only — no browser opens.

---

## GitHub Integration

JARVIS uses the official GitHub CLI (`gh`).

### Setup
1. Install GitHub CLI: https://cli.github.com
2. Authenticate: `gh auth login`
3. Use from JARVIS: "Check GitHub authentication status"

### Example voice commands
- "Check GitHub authentication status"
- "Check my git status"
- "Show git diff"
- (Commit/push trigger confirmation dialog in dashboard)

### Security
- Secrets are scanned before every commit
- `.env`, `*.db`, `*.sqlite`, `node_modules`, `logs/`, `*.pid` are gitignored
- Pushes and repository creation require approval in the dashboard

---

## Permission System

| Category | Examples | Behaviour |
|---|---|---|
| **A — Ordinary** | Open app, check time, git status, read file | Executes automatically |
| **B — Consequential** | Shutdown, commit, push, write file | Queues in Approvals tab |
| **C — High-risk** | Delete file, run arbitrary script | Blocked via direct API; requires special workflow |

---

## Phone Integration

Phone integration is not yet configured. To proceed, provide:

1. Phone operating system (Android / iOS)
2. Phone model
3. Preferred connection method (USB, Wi-Fi, Bluetooth)

Once provided, JARVIS will identify the correct integration approach:
- **Android**: ADB, companion app, or KDE Connect
- **iOS**: Shortcuts app webhook, or other permitted methods

The phone module is designed as a separate service that does not expose an unauthenticated server to the internet.

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Backend health + provider info |
| `/api/chat` | POST | Conversational AI |
| `/api/agent` | POST | NL → plan → execute |
| `/api/actions/list` | GET | All registered actions |
| `/api/actions/execute` | POST | Execute a single action |
| `/api/approvals` | GET | Pending approvals |
| `/api/approvals/:id/resolve` | POST | Approve or reject |
| `/api/memories` | GET/POST | List / create memories |
| `/api/memories/:id` | DELETE | Delete a memory |
| `/api/provider` | GET/POST | Get / switch AI provider |
| `/api/system/info` | GET | System information |
| `/api/git/status` | GET | Git status for JARVIS project |
| `/api/voice/status` | GET | Voice service heartbeat |
| `/api/voice/heartbeat` | POST | Voice service registration |

---

## Security

- AI-generated text **never** becomes executable shell commands
- All actions go through typed handlers with validated arguments
- `.env`, `*.db`, credentials, `node_modules`, and logs are gitignored
- API binds to `127.0.0.1` only (not exposed to network)
- Destructive actions (shutdown, delete, push) require dashboard approval
- Files outside configured `allowedPaths` cannot be read or written
- Credential files (`.env`, `id_rsa`) are blocked at the file-operations layer

---

## Known Limitations

| Feature | Status | Notes |
|---|---|---|
| Wake word (local) | ✅ Working | Uses `openwakeword`; falls back to Google STT |
| Voice TTS | ✅ Working | SAPI5 voices via `pyttsx3` |
| Agent actions | ✅ Working | 25 registered actions |
| Gemini + Ollama | ✅ Working | Provider switchable at runtime |
| Persistent memory | ✅ Working | SQLite, preserved across sessions |
| GitHub CLI | ✅ Working | Requires `gh auth login` |
| Phone integration | 🔜 Pending | Requires your phone OS/model |
| Coding agent (full) | 🔜 Partial | File read/write/search works; AI-assisted editing planned |
| Startup task | ✅ Implemented | Requires explicit approval via `manage-jarvis.ps1` |
| PyAudio on Windows | ✅ Installed | Required for `openwakeword` microphone access |

---

## Test Results (Phase 10)

Ran 2026-10-26 against live backend:

```
✓ Health: provider=ollama, gemini_available=True
✓ Provider endpoint: current=ollama
✓ Agent time: mode=action, steps=1
✓ Agent git: mode=action, branch=main
✓ Actions registered: 25
✓ Memories count: 6 (existing memories preserved)
✓ Pending approvals: 0
✓ Voice service: online=False (not started)
✓ Switch provider: gemini
✓ Switch back: ollama
✓ Memory save: memorySaved=True
✓ Action execute GET_SYSTEM_INFO: success=True
✓ Frontend TypeScript: 0 errors
✓ Frontend production build: ✓ (241 kB bundle)
```

---

*JARVIS Personal AI — Build 0.5.0 — Windows 11 · Node.js 24 · Python 3.12*
