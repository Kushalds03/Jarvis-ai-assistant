
/**
 * JARVIS Git / GitHub Actions
 *
 * All git and gh CLI interactions use validated, pre-built argument lists.
 * Arguments are never assembled from raw AI-generated strings.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { JARVIS_CONFIG, resolveProject } from "./config.js";

const execFileAsync = promisify(execFile);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a `git` command inside a project working directory.
 * Arguments must be a pre-built, validated array — never a shell string.
 */
async function git(cwd, args, timeoutMs = 30_000) {
    return execFileAsync("git", args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1_000_000,
    });
}

/**
 * Run a `gh` (GitHub CLI) command.
 */
async function gh(args, cwd, timeoutMs = 30_000) {
    return execFileAsync("gh", args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 500_000,
    });
}

/**
 * Resolve a project path, falling back to the JARVIS project root.
 */
function resolveProjectPath(projectKey) {
    const project = projectKey
        ? resolveProject(projectKey)
        : resolveProject("jarvis");

    if (!project) return null;

    return project.path;
}

/**
 * Check whether a directory is a git repository.
 */
function isGitRepo(dirPath) {
    return fs.existsSync(path.join(dirPath, ".git"));
}

// ─── Secret Detection ─────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
    /AKIA[0-9A-Z]{16}/,                  // AWS access key
    /sk-[A-Za-z0-9]{20,}/,               // OpenAI / many services
    /ghp_[A-Za-z0-9]{36}/,               // GitHub personal access token
    /AIza[0-9A-Za-z\-_]{35}/,            // Google API key
    /[0-9a-f]{32}/,                       // Generic hex tokens (length 32)
    /PRIVATE KEY/,
];

/**
 * Scan staged diff output for potential secrets.
 * Returns a list of warnings.
 */
function scanForSecrets(diffOutput) {
    const warnings = [];
    const lines = diffOutput.split("\n");

    for (const line of lines) {
        if (!line.startsWith("+")) continue; // Only check added lines
        if (line.startsWith("+++")) continue;

        for (const pattern of SECRET_PATTERNS) {
            if (pattern.test(line)) {
                warnings.push(`Potential secret detected: ${line.slice(0, 80)}`);
                break;
            }
        }
    }

    return warnings;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export async function gitStatus(projectKey) {
    const cwd = resolveProjectPath(projectKey);
    if (!cwd) return { success: false, message: "Project not found." };
    if (!isGitRepo(cwd)) return { success: false, message: `${cwd} is not a git repository.` };

    try {
        const [statusRes, branchRes, logRes] = await Promise.allSettled([
            git(cwd, ["status", "--short", "--branch"]),
            git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
            git(cwd, ["log", "--oneline", "-5"]),
        ]);

        return {
            success: true,
            cwd,
            status: statusRes.status === "fulfilled" ? statusRes.value.stdout.trim() : null,
            branch: branchRes.status === "fulfilled" ? branchRes.value.stdout.trim() : null,
            recentCommits: logRes.status === "fulfilled"
                ? logRes.value.stdout.trim().split("\n").filter(Boolean)
                : [],
        };
    } catch (err) {
        return { success: false, message: `git status failed: ${err.message}` };
    }
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

export async function gitDiff(projectKey, staged = false) {
    const cwd = resolveProjectPath(projectKey);
    if (!cwd) return { success: false, message: "Project not found." };
    if (!isGitRepo(cwd)) return { success: false, message: `${cwd} is not a git repository.` };

    const args = staged ? ["diff", "--staged"] : ["diff"];

    try {
        const { stdout } = await git(cwd, args);
        const diff = stdout.trim();
        const secretWarnings = diff ? scanForSecrets(diff) : [];

        return {
            success: true,
            diff: diff || "(no changes)",
            staged,
            secretWarnings,
            hasSecrets: secretWarnings.length > 0,
        };
    } catch (err) {
        return { success: false, message: `git diff failed: ${err.message}` };
    }
}

// ─── Log ─────────────────────────────────────────────────────────────────────

export async function gitLog(projectKey, limit = 10) {
    const cwd = resolveProjectPath(projectKey);
    if (!cwd) return { success: false, message: "Project not found." };
    if (!isGitRepo(cwd)) return { success: false, message: `${cwd} is not a git repository.` };

    try {
        const { stdout } = await git(cwd, [
            "log",
            "--oneline",
            "--decorate",
            `-${Math.min(limit, 50)}`,
        ]);

        return {
            success: true,
            log: stdout.trim(),
            commits: stdout.trim().split("\n").filter(Boolean),
        };
    } catch (err) {
        return { success: false, message: `git log failed: ${err.message}` };
    }
}

// ─── Branch Operations ────────────────────────────────────────────────────────

export async function gitBranch(projectKey, action, name) {
    const cwd = resolveProjectPath(projectKey);
    if (!cwd) return { success: false, message: "Project not found." };
    if (!isGitRepo(cwd)) return { success: false, message: `${cwd} is not a git repository.` };

    // Validate branch name to prevent injection.
    if (name && !/^[a-zA-Z0-9._/-]{1,100}$/.test(name)) {
        return { success: false, message: "Invalid branch name. Use letters, numbers, hyphens, underscores, and slashes only." };
    }

    try {
        if (action === "list") {
            const { stdout } = await git(cwd, ["branch", "-a"]);
            return { success: true, branches: stdout.trim().split("\n").map(b => b.trim()) };
        }

        if (action === "create") {
            if (!name) return { success: false, message: "Branch name is required." };
            const { stdout } = await git(cwd, ["checkout", "-b", name]);
            return { success: true, message: `Branch "${name}" created and checked out.`, output: stdout };
        }

        if (action === "checkout") {
            if (!name) return { success: false, message: "Branch name is required." };
            const { stdout } = await git(cwd, ["checkout", name]);
            return { success: true, message: `Switched to branch "${name}".`, output: stdout };
        }

        return { success: false, message: `Unknown branch action: ${action}` };
    } catch (err) {
        return { success: false, message: `Branch operation failed: ${err.stderr || err.message}` };
    }
}

// ─── Commit ───────────────────────────────────────────────────────────────────

export async function gitCommit(projectKey, message, addAll = true) {
    const cwd = resolveProjectPath(projectKey);
    if (!cwd) return { success: false, message: "Project not found." };
    if (!isGitRepo(cwd)) return { success: false, message: `${cwd} is not a git repository.` };

    if (!message || message.trim().length < 3) {
        return { success: false, message: "Commit message must be at least 3 characters." };
    }

    // Check staged diff for secrets BEFORE committing.
    if (addAll) {
        try {
            await git(cwd, ["add", "-A"]);
        } catch (err) {
            return { success: false, message: `git add failed: ${err.message}` };
        }
    }

    const diffResult = await gitDiff(projectKey, true);
    if (diffResult.hasSecrets) {
        return {
            success: false,
            message: "Commit aborted. Potential secrets detected in staged changes.",
            secretWarnings: diffResult.secretWarnings,
        };
    }

    if (!diffResult.diff || diffResult.diff === "(no changes)") {
        return { success: false, message: "Nothing to commit. Working tree is clean." };
    }

    try {
        const { stdout } = await git(cwd, ["commit", "-m", message.trim()]);
        return { success: true, message: "Changes committed successfully.", output: stdout.trim() };
    } catch (err) {
        return { success: false, message: `git commit failed: ${err.stderr || err.message}` };
    }
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export async function gitPush(projectKey, remote = "origin", branch) {
    const cwd = resolveProjectPath(projectKey);
    if (!cwd) return { success: false, message: "Project not found." };
    if (!isGitRepo(cwd)) return { success: false, message: `${cwd} is not a git repository.` };

    // Validate remote name.
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(remote)) {
        return { success: false, message: "Invalid remote name." };
    }

    // Validate branch name if supplied.
    if (branch && !/^[a-zA-Z0-9._/-]{1,100}$/.test(branch)) {
        return { success: false, message: "Invalid branch name." };
    }

    const args = branch
        ? ["push", remote, branch]
        : ["push", remote];

    try {
        const { stdout, stderr } = await git(cwd, args, 60_000);
        return {
            success: true,
            message: "Push succeeded.",
            output: (stdout + stderr).trim(),
        };
    } catch (err) {
        return { success: false, message: `git push failed: ${err.stderr || err.message}` };
    }
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

export async function gitPull(projectKey) {
    const cwd = resolveProjectPath(projectKey);
    if (!cwd) return { success: false, message: "Project not found." };
    if (!isGitRepo(cwd)) return { success: false, message: `${cwd} is not a git repository.` };

    try {
        const { stdout, stderr } = await git(cwd, ["pull"], 60_000);
        return { success: true, output: (stdout + stderr).trim() };
    } catch (err) {
        return { success: false, message: `git pull failed: ${err.stderr || err.message}` };
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function gitInit(projectKey, dirPath) {
    const cwd = dirPath || resolveProjectPath(projectKey);
    if (!cwd) return { success: false, message: "Project or directory not found." };

    if (isGitRepo(cwd)) {
        return { success: false, message: `${cwd} is already a git repository.` };
    }

    try {
        const { stdout } = await git(cwd, ["init"]);
        return { success: true, message: `Git repository initialised in ${cwd}.`, output: stdout.trim() };
    } catch (err) {
        return { success: false, message: `git init failed: ${err.message}` };
    }
}

// ─── GitHub CLI ───────────────────────────────────────────────────────────────

export async function githubAuthStatus() {
    try {
        const { stdout } = await gh(["auth", "status"]);
        return { success: true, authenticated: true, details: stdout.trim() };
    } catch (err) {
        const msg = err.stderr || err.message || "";
        const notLoggedIn = msg.includes("not logged in") || msg.includes("not authenticated");

        return {
            success: false,
            authenticated: false,
            message: notLoggedIn
                ? "GitHub CLI is not authenticated. Run: gh auth login"
                : `gh auth status failed: ${msg}`,
        };
    }
}

export async function githubCreateRepo(name, isPrivate = true, description = "") {
    // Validate repo name.
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(name)) {
        return { success: false, message: "Invalid repository name. Use letters, numbers, hyphens, dots, and underscores." };
    }

    const args = [
        "repo", "create", name,
        isPrivate ? "--private" : "--public",
        "--description", (description || "Created by JARVIS").slice(0, 200),
        "--source", ".",
        "--push",
    ];

    try {
        const { stdout } = await gh(args, process.cwd(), 60_000);
        return {
            success: true,
            message: `Repository "${name}" created on GitHub.`,
            output: stdout.trim(),
            visibility: isPrivate ? "private" : "public",
        };
    } catch (err) {
        return {
            success: false,
            message: `Failed to create GitHub repo: ${err.stderr || err.message}`,
        };
    }
}
