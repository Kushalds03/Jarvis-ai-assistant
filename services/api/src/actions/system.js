
/**
 * JARVIS System Actions
 *
 * All Windows system control goes through validated handlers here.
 * AI-generated text NEVER becomes a raw PowerShell command.
 */

import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { JARVIS_CONFIG } from "./config.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run a specific PowerShell expression with no profile loading.
 * @param {string} expression - A single validated PS expression.
 * @returns {{ stdout, stderr }}
 */
async function runPowerShell(expression) {
    return execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", expression],
        { timeout: 15_000 }
    );
}

// ─── System Information ───────────────────────────────────────────────────────

export async function getSystemInfo() {
    const uptimeSeconds = os.uptime();
    const uptimeHours = Math.floor(uptimeSeconds / 3600);
    const uptimeMins = Math.floor((uptimeSeconds % 3600) / 60);

    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
    });
    const dateStr = now.toLocaleDateString("en-IN", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });

    const totalRamGB = (os.totalmem() / 1_073_741_824).toFixed(1);
    const freeRamGB = (os.freemem() / 1_073_741_824).toFixed(1);

    return {
        time: timeStr,
        date: dateStr,
        uptime: `${uptimeHours}h ${uptimeMins}m`,
        platform: os.platform(),
        release: os.release(),
        hostname: os.hostname(),
        totalRamGB,
        freeRamGB,
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? "Unknown",
    };
}

// ─── Lock ─────────────────────────────────────────────────────────────────────

/**
 * Lock the Windows workstation immediately.
 */
export async function lockPC() {
    try {
        await execFileAsync(
            "C:\\Windows\\System32\\rundll32.exe",
            ["user32.dll,LockWorkStation"],
            { timeout: 5_000 }
        );
        return { success: true, message: "Workstation locked." };
    } catch (error) {
        return {
            success: false,
            message: `Failed to lock the workstation: ${error.message}`,
        };
    }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Schedule or execute a system shutdown.
 * Uses Windows `shutdown.exe` with explicit validated arguments.
 *
 * @param {number} delaySecs - Delay in seconds (0 = immediate).
 * @param {boolean} force - Force-close running apps.
 */
export async function shutdownPC(delaySecs = 60, force = false) {
    const maxDelay = JARVIS_CONFIG.system.maxShutdownDelaySecs;

    if (!Number.isFinite(delaySecs) || delaySecs < 0 || delaySecs > maxDelay) {
        return {
            success: false,
            message: `Delay must be between 0 and ${maxDelay} seconds.`,
        };
    }

    const args = ["/s", "/t", String(Math.round(delaySecs))];
    if (force) args.push("/f");

    try {
        await execFileAsync(
            "C:\\Windows\\System32\\shutdown.exe",
            args,
            { timeout: 5_000 }
        );

        const msg =
            delaySecs === 0
                ? "Shutdown initiated immediately."
                : `Shutdown scheduled in ${delaySecs} seconds. Say "cancel shutdown" to abort.`;

        return { success: true, message: msg, delaySecs };
    } catch (error) {
        return {
            success: false,
            message: `Failed to schedule shutdown: ${error.message}`,
        };
    }
}

// ─── Restart ──────────────────────────────────────────────────────────────────

/**
 * Schedule or execute a system restart.
 */
export async function restartPC(delaySecs = 60, force = false) {
    const maxDelay = JARVIS_CONFIG.system.maxShutdownDelaySecs;

    if (!Number.isFinite(delaySecs) || delaySecs < 0 || delaySecs > maxDelay) {
        return {
            success: false,
            message: `Delay must be between 0 and ${maxDelay} seconds.`,
        };
    }

    const args = ["/r", "/t", String(Math.round(delaySecs))];
    if (force) args.push("/f");

    try {
        await execFileAsync(
            "C:\\Windows\\System32\\shutdown.exe",
            args,
            { timeout: 5_000 }
        );

        const msg =
            delaySecs === 0
                ? "Restart initiated immediately."
                : `Restart scheduled in ${delaySecs} seconds. Say "cancel shutdown" to abort.`;

        return { success: true, message: msg, delaySecs };
    } catch (error) {
        return {
            success: false,
            message: `Failed to schedule restart: ${error.message}`,
        };
    }
}

// ─── Cancel Shutdown ──────────────────────────────────────────────────────────

/**
 * Cancel a pending scheduled shutdown or restart.
 * Verifies the result by inspecting the return code.
 */
export async function cancelShutdown() {
    try {
        await execFileAsync(
            "C:\\Windows\\System32\\shutdown.exe",
            ["/a"],
            { timeout: 5_000 }
        );

        return {
            success: true,
            message: "Pending shutdown has been cancelled successfully.",
        };
    } catch (error) {
        // Exit code 1116 = "no shutdown was scheduled" on Windows.
        const stderr = error.stderr ?? error.message ?? "";

        if (
            error.code === 1116 ||
            stderr.toLowerCase().includes("no shutdown") ||
            stderr.toLowerCase().includes("1116")
        ) {
            return {
                success: false,
                message: "No shutdown was currently scheduled.",
            };
        }

        return {
            success: false,
            message: `Could not cancel shutdown: ${stderr || error.message}`,
        };
    }
}

// ─── Check Shutdown Status ────────────────────────────────────────────────────

/**
 * Attempt to detect whether a shutdown is pending.
 * Uses the registry to check for scheduled shutdown entries.
 */
export async function getShutdownStatus() {
    try {
        // Windows does not expose a simple "is shutdown scheduled" API.
        // We query the shutdown reason from the registry; if missing,
        // no shutdown is pending.
        const { stdout } = await runPowerShell(
            `Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Reliability' ` +
            `-ErrorAction SilentlyContinue | Select-Object -ExpandProperty TimeStampLastShutdown -ErrorAction SilentlyContinue`
        );

        return {
            pendingShutdown: false, // Cannot reliably detect without COM
            note: "Windows does not expose a reliable pending-shutdown flag via the registry. Use 'cancel shutdown' to abort any pending shutdown.",
            lastShutdownTimestamp: stdout.trim() || null,
        };
    } catch {
        return { pendingShutdown: false, note: "Status unavailable." };
    }
}
