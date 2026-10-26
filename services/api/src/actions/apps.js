
/**
 * JARVIS Application Launcher
 *
 * Opens registered applications or URLs using validated executable paths.
 * Never runs arbitrary commands from AI-generated text.
 */

import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { JARVIS_CONFIG, resolveApp } from "./config.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Verify that an executable exists at the given path.
 */
function executableExists(exePath) {
    if (!exePath) return false;
    // Handle glob patterns (simple case – check parent dir)
    if (exePath.includes("*")) return false;
    try {
        return fs.existsSync(exePath);
    } catch {
        return false;
    }
}

// ─── Open Application ─────────────────────────────────────────────────────────

/**
 * Open an application by its registered key.
 *
 * @param {string} appKey - Key from JARVIS_CONFIG.applications.
 * @param {string[]} [extraArgs] - Optional extra arguments.
 */
export async function openApp(appKey, extraArgs = []) {
    const app = JARVIS_CONFIG.applications[appKey];

    if (!app) {
        return { success: false, message: `Unknown application key: ${appKey}` };
    }

    // URL-based app (e.g. JARVIS dashboard)
    if (app.url) {
        return openUrl(app.url);
    }

    // Try explicit executable path first
    if (app.executable && executableExists(app.executable)) {
        const args = [
            ...(app.args ?? []),
            ...extraArgs,
        ];

        try {
            execFile(app.executable, args, { detached: true }, () => { });
            return {
                success: true,
                message: `${app.name} is opening.`,
                method: "executable",
            };
        } catch (error) {
            // fall through to fallback
        }
    }

    // Fallback: use `start` command (Windows shell verb)
    if (app.fallbackCmd) {
        try {
            exec(app.fallbackCmd, { timeout: 5_000 });
            return {
                success: true,
                message: `${app.name} is opening.`,
                method: "fallback",
            };
        } catch (error) {
            return {
                success: false,
                message: `Could not open ${app.name}: ${error.message}`,
            };
        }
    }

    return {
        success: false,
        message:
            `Could not open ${app.name}. ` +
            `The executable was not found at: ${app.executable ?? "(none configured)"}`,
    };
}

// ─── Open Folder ─────────────────────────────────────────────────────────────

/**
 * Open a folder in Windows File Explorer.
 * The path must be an allowed JARVIS path.
 *
 * @param {string} folderPath - Absolute Windows path.
 */
export async function openFolder(folderPath) {
    if (!fs.existsSync(folderPath)) {
        return { success: false, message: `Folder not found: ${folderPath}` };
    }

    try {
        execFile("explorer.exe", [folderPath], { detached: true }, () => { });
        return { success: true, message: `Opened folder: ${folderPath}` };
    } catch (error) {
        return {
            success: false,
            message: `Could not open folder: ${error.message}`,
        };
    }
}

// ─── Open URL ─────────────────────────────────────────────────────────────────

/**
 * Open a URL in the default system browser.
 *
 * @param {string} url - Must begin with https:// or http://.
 */
export async function openUrl(url) {
    if (!/^https?:\/\//i.test(url)) {
        return { success: false, message: "Only http:// and https:// URLs are supported." };
    }

    try {
        exec(`start "${url}"`, { timeout: 5_000 });
        return { success: true, message: `Opened URL: ${url}` };
    } catch (error) {
        return { success: false, message: `Could not open URL: ${error.message}` };
    }
}

// ─── Resolve and Open by Natural Language ─────────────────────────────────────

/**
 * Resolve an app from a natural-language query and open it.
 *
 * @param {string} query - e.g. "vs code", "chrome", "calculator"
 */
export async function openAppByQuery(query) {
    const app = resolveApp(query);

    if (!app) {
        return {
            success: false,
            message: `I don't have "${query}" in my application registry. ` +
                `Available apps: ${Object.values(JARVIS_CONFIG.applications)
                    .map((a) => a.name)
                    .join(", ")}.`,
        };
    }

    return openApp(app.key);
}

// ─── List Available Apps ──────────────────────────────────────────────────────

export function listAvailableApps() {
    return Object.entries(JARVIS_CONFIG.applications).map(([key, app]) => ({
        key,
        name: app.name,
        aliases: app.aliases,
        hasExecutable: !!(app.executable || app.fallbackCmd || app.url),
        type: app.url ? "url" : app.executable ? "executable" : "command",
    }));
}
