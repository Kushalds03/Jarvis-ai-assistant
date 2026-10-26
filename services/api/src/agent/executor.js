
/**
 * JARVIS Task Executor
 *
 * Executes validated action plans produced by the planner.
 * Each action step is dispatched through its registered handler.
 * No raw AI text reaches the operating system.
 */

import { validateAction } from "../actions/registry.js";
import { lockPC, shutdownPC, restartPC, cancelShutdown, getSystemInfo } from "../actions/system.js";
import { openApp, openFolder, openUrl } from "../actions/apps.js";
import { readFile, listDir, searchFiles, writeFile, createDir } from "../actions/files.js";
import {
    gitStatus, gitDiff, gitLog, gitBranch, gitCommit, gitPush, gitPull, gitInit,
    githubAuthStatus, githubCreateRepo,
} from "../actions/git.js";

// ─── Action Dispatch Map ──────────────────────────────────────────────────────
// Maps action IDs to their handler functions.

const ACTION_HANDLERS = {
    // System
    LOCK_PC: (args) => lockPC(),
    SHUTDOWN_PC: (args) => shutdownPC(args.delaySecs ?? 60, args.force ?? false),
    RESTART_PC: (args) => restartPC(args.delaySecs ?? 60, args.force ?? false),
    CANCEL_SHUTDOWN: (args) => cancelShutdown(),
    GET_SYSTEM_INFO: (args) => getSystemInfo(),

    // Applications
    OPEN_APP: (args) => openApp(args.appKey, args.args ?? []),
    OPEN_FOLDER: (args) => openFolder(args.folderPath),
    OPEN_URL: (args) => openUrl(args.url),

    // Files
    READ_FILE: (args) => readFile(args.filePath, args.maxBytes),
    LIST_DIR: (args) => listDir(args.dirPath),
    SEARCH_FILES: (args) => searchFiles(args.basePath, args.pattern),
    WRITE_FILE: (args) => writeFile(args.filePath, args.content, {
        createDirs: args.createDirs ?? true,
        overwrite: args.overwrite ?? false,
    }),
    CREATE_DIR: (args) => createDir(args.dirPath),

    // Git
    GIT_STATUS: (args) => gitStatus(args.projectKey),
    GIT_DIFF: (args) => gitDiff(args.projectKey, args.staged ?? false),
    GIT_LOG: (args) => gitLog(args.projectKey, args.limit ?? 10),
    GIT_BRANCH: (args) => gitBranch(args.projectKey, args.action, args.name),
    GIT_COMMIT: (args) => gitCommit(args.projectKey, args.message, args.addAll ?? true),
    GIT_PUSH: (args) => gitPush(args.projectKey, args.remote ?? "origin", args.branch),
    GIT_PULL: (args) => gitPull(args.projectKey),
    GIT_INIT: (args) => gitInit(args.projectKey, args.dirPath),
    GITHUB_AUTH_STATUS: () => githubAuthStatus(),
    GITHUB_CREATE_REPO: (args) => githubCreateRepo(args.name, args.private ?? true, args.description),
};

// ─── Step Executor ────────────────────────────────────────────────────────────

/**
 * Execute a single validated action step.
 *
 * @param {{ actionId: string, args: object }} step
 * @returns {Promise<{ success, result, error }>}
 */
export async function executeStep(step) {
    const { actionId, args = {} } = step;

    // Validate against schema.
    const validation = validateAction(actionId, args);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    const handler = ACTION_HANDLERS[actionId];
    if (!handler) {
        return { success: false, error: `No handler registered for action: ${actionId}` };
    }

    try {
        const result = await Promise.race([
            handler(args),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Action timed out")), 30_000)
            ),
        ]);

        return { success: result?.success ?? true, result };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ─── Plan Executor ────────────────────────────────────────────────────────────

/**
 * Execute a multi-step plan produced by the planner.
 *
 * @param {object} plan - { steps: [{ actionId, args }], intent, reply }
 * @param {object} options - { onProgress }
 * @returns {Promise<ExecutionResult>}
 */
export async function executePlan(plan, options = {}) {
    const { onProgress } = options;
    const results = [];
    let failed = false;

    for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];

        onProgress?.({
            stepIndex: i,
            totalSteps: plan.steps.length,
            actionId: step.actionId,
            status: "running",
        });

        const stepResult = await executeStep(step);
        results.push({ ...step, ...stepResult });

        onProgress?.({
            stepIndex: i,
            totalSteps: plan.steps.length,
            actionId: step.actionId,
            status: stepResult.success ? "done" : "failed",
            result: stepResult.result,
            error: stepResult.error,
        });

        if (!stepResult.success) {
            failed = true;

            // Non-recoverable failure — stop execution.
            if (isCriticalAction(step.actionId)) break;
        }
    }

    const successCount = results.filter((r) => r.success).length;

    return {
        intent: plan.intent,
        totalSteps: plan.steps.length,
        completedSteps: successCount,
        failed,
        results,
        summary: buildSummary(plan, results, failed),
    };
}

function isCriticalAction(actionId) {
    return ["SHUTDOWN_PC", "RESTART_PC", "DELETE_FILE"].includes(actionId);
}

function buildSummary(plan, results, failed) {
    const successCount = results.filter((r) => r.success).length;
    const total = results.length;

    if (!failed) {
        return `Completed ${total} step${total !== 1 ? "s" : ""} successfully.`;
    }

    return `Completed ${successCount} of ${total} steps. ` +
        results
            .filter((r) => !r.success)
            .map((r) => `${r.actionId}: ${r.error || r.result?.message || "Failed"}`)
            .join("; ");
}
