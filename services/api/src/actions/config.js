
/**
 * JARVIS Action Configuration
 *
 * Edit this file to:
 *  - Register applications JARVIS can open.
 *  - Add project directories JARVIS can work with.
 *  - Configure allowed filesystem paths.
 *  - Tune system-action confirmation settings.
 */

import os from "node:os";
import path from "node:path";

export const JARVIS_CONFIG = {
    // ─── Registered Applications ────────────────────────────────────────────
    applications: {
        chrome: {
            name: "Google Chrome",
            aliases: ["chrome", "google chrome", "browser", "web browser"],
            executable:
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            fallbackCmd: "start chrome",
        },
        edge: {
            name: "Microsoft Edge",
            aliases: ["edge", "microsoft edge", "ms edge"],
            executable:
                "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            fallbackCmd: "start msedge",
        },
        vscode: {
            name: "Visual Studio Code",
            aliases: [
                "vs code",
                "vscode",
                "code",
                "visual studio code",
                "editor",
                "vs code editor",
            ],
            executable: path.join(
                process.env.LOCALAPPDATA || os.homedir(),
                "Programs",
                "Microsoft VS Code",
                "Code.exe"
            ),
            fallbackCmd: "code",
        },
        notepad: {
            name: "Notepad",
            aliases: ["notepad", "text editor", "notes", "notepad++"],
            executable: "C:\\Windows\\System32\\notepad.exe",
        },
        calculator: {
            name: "Calculator",
            aliases: ["calculator", "calc", "calculations"],
            executable: "C:\\Windows\\System32\\calc.exe",
            fallbackCmd: "start calc",
        },
        taskmanager: {
            name: "Task Manager",
            aliases: ["task manager", "taskmgr", "processes", "task mgr"],
            executable: "C:\\Windows\\System32\\Taskmgr.exe",
        },
        explorer: {
            name: "File Explorer",
            aliases: ["file explorer", "explorer", "files", "my computer", "this pc"],
            executable: "C:\\Windows\\explorer.exe",
        },
        terminal: {
            name: "Windows Terminal",
            aliases: ["terminal", "windows terminal", "command prompt", "shell", "console"],
            executable: path.join(
                process.env.LOCALAPPDATA || os.homedir(),
                "Microsoft",
                "WindowsApps",
                "wt.exe"
            ),
            fallbackCmd: "start wt",
        },
        powershell: {
            name: "PowerShell",
            aliases: ["powershell", "ps", "pwsh"],
            executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        },
        spotify: {
            name: "Spotify",
            aliases: ["spotify", "music", "play music"],
            fallbackCmd: "start spotify:",
        },
        discord: {
            name: "Discord",
            aliases: ["discord", "chat", "voice chat"],
            executable: path.join(
                process.env.LOCALAPPDATA || os.homedir(),
                "Discord",
                "app-*",
                "Discord.exe"
            ),
            fallbackCmd: "start discord:",
        },
        vlc: {
            name: "VLC Media Player",
            aliases: ["vlc", "media player", "video player"],
            executable: "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
        },
        paint: {
            name: "Microsoft Paint",
            aliases: ["paint", "mspaint", "image editor"],
            executable: "C:\\Windows\\System32\\mspaint.exe",
        },
        wordpad: {
            name: "WordPad",
            aliases: ["wordpad", "word pad"],
            executable: "C:\\Program Files\\Windows NT\\Accessories\\wordpad.exe",
        },
        controlpanel: {
            name: "Control Panel",
            aliases: ["control panel", "settings", "windows settings"],
            fallbackCmd: "start ms-settings:",
        },
        jarvis: {
            name: "JARVIS Dashboard",
            aliases: ["jarvis dashboard", "dashboard", "jarvis interface", "my dashboard"],
            url: "http://localhost:5173",
        },
    },

    // ─── Registered Projects ─────────────────────────────────────────────────
    projects: {
        jarvis: {
            name: "JARVIS Project",
            aliases: ["jarvis", "this project", "my assistant", "ai assistant"],
            path: "D:\\Sigma batch\\Jarvis",
            type: "node",
            packageManager: "npm",
            backendPath: "services/api",
            frontendPath: "apps/web",
            devBackendCmd: ["npm", "run", "dev"],
            devFrontendCmd: ["npm", "run", "dev"],
            testCmd: null,
            buildCmd: ["npm", "run", "build"],
            mainBranch: "main",
        },
    },

    // ─── Allowed Filesystem Paths ─────────────────────────────────────────────
    allowedPaths: [
        "D:\\Sigma batch\\Jarvis",
        path.join(os.homedir(), "Documents"),
        path.join(os.homedir(), "Desktop"),
        path.join(os.homedir(), "Downloads"),
        path.join(os.homedir(), "Projects"),
        path.join(os.homedir(), "dev"),
        path.join(os.homedir(), "source"),
    ],

    // ─── System Confirmation Policy ───────────────────────────────────────────
    system: {
        confirmShutdown: true,
        confirmRestart: true,
        confirmLogout: true,
        confirmLock: false,          // Lock is low-risk
        maxShutdownDelaySecs: 3600,
        defaultShutdownDelaySecs: 60,
    },

    // ─── Voice Service ────────────────────────────────────────────────────────
    voice: {
        statusPort: 3001,
        wakeWords: ["jarvis", "hey jarvis"],
        language: "en-IN",
        tts: "pyttsx3",             // 'pyttsx3' | 'edge-tts'
        edgeTtsVoice: "en-US-AriaNeural",
    },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find a registered application by its alias or name.
 * Returns the full app definition or null.
 */
export function resolveApp(query) {
    const q = query.toLowerCase().trim();
    for (const [key, app] of Object.entries(JARVIS_CONFIG.applications)) {
        if (
            key === q ||
            app.name.toLowerCase() === q ||
            app.aliases.some((a) => q.includes(a) || a.includes(q))
        ) {
            return { key, ...app };
        }
    }
    return null;
}

/**
 * Find a registered project by key or alias.
 * If only one project is configured, return it automatically.
 */
export function resolveProject(query) {
    const q = (query || "").toLowerCase().trim();
    const entries = Object.entries(JARVIS_CONFIG.projects);

    for (const [key, project] of entries) {
        if (
            key === q ||
            project.name.toLowerCase() === q ||
            (project.aliases || []).some((a) => q.includes(a) || a.includes(q))
        ) {
            return { key, ...project };
        }
    }

    // Default to the only project when there is exactly one.
    if (entries.length === 1) {
        const [key, project] = entries[0];
        return { key, ...project };
    }

    return null;
}

/**
 * Verify that targetPath is inside one of the configured allowed base paths.
 */
export function isPathAllowed(targetPath) {
    const normalised = path.normalize(targetPath).toLowerCase();
    return JARVIS_CONFIG.allowedPaths.some((allowed) =>
        normalised.startsWith(path.normalize(allowed).toLowerCase())
    );
}
