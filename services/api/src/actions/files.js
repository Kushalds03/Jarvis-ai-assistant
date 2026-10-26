
/**
 * JARVIS File Operations
 *
 * All file-system access is validated against the allowedPaths list.
 * Destructive operations are gated with explicit permission categories.
 */

import fs from "node:fs";
import path from "node:path";
import { JARVIS_CONFIG, isPathAllowed } from "./config.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 100_000; // 100 KB default read limit
const MAX_READ_BYTES = 500_000;    // Hard ceiling

// Text / source-code file extensions JARVIS is allowed to read.
const READABLE_EXTENSIONS = new Set([
    ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".toml",
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".py", ".rb", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".cs",
    ".html", ".htm", ".css", ".scss", ".sass", ".less",
    ".sh", ".ps1", ".bat", ".cmd",
    ".env.example",          // allowed; .env itself is blocked below
    ".gitignore", ".gitattributes", ".editorconfig", ".eslintrc",
    ".prettierrc", "package.json", "tsconfig.json", "vite.config.ts",
    "Makefile", "Dockerfile", "docker-compose.yml",
    ".log", ".csv", ".xml",
]);

// Files that must never be read regardless of extension.
const BLOCKED_FILENAMES = new Set([
    ".env", ".env.local", ".env.production", ".env.development",
    "id_rsa", "id_ed25519", "id_dsa",
]);

// ─── Guards ───────────────────────────────────────────────────────────────────

function guardPath(targetPath, operation = "access") {
    const resolved = path.resolve(targetPath);

    if (!isPathAllowed(resolved)) {
        return {
            allowed: false,
            error: `Access denied: ${resolved} is outside the configured allowed paths.`,
        };
    }

    return { allowed: true, resolved };
}

function guardReadFile(resolvedPath) {
    const basename = path.basename(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();

    if (BLOCKED_FILENAMES.has(basename)) {
        return {
            allowed: false,
            error: `Reading ${basename} is blocked to protect credentials.`,
        };
    }

    if (!READABLE_EXTENSIONS.has(ext) && !READABLE_EXTENSIONS.has(basename)) {
        return {
            allowed: false,
            error: `Reading ${ext} files is not permitted. Only source-code and text files are allowed.`,
        };
    }

    return { allowed: true };
}

// ─── Read File ────────────────────────────────────────────────────────────────

/**
 * Read a text / source-code file.
 *
 * @param {string} filePath
 * @param {number} [maxBytes]
 */
export function readFile(filePath, maxBytes = DEFAULT_MAX_BYTES) {
    const safeMax = Math.min(maxBytes ?? DEFAULT_MAX_BYTES, MAX_READ_BYTES);
    const { allowed, resolved, error } = guardPath(filePath, "read");

    if (!allowed) return { success: false, message: error };

    const readGuard = guardReadFile(resolved);
    if (!readGuard.allowed) return { success: false, message: readGuard.error };

    if (!fs.existsSync(resolved)) {
        return { success: false, message: `File not found: ${resolved}` };
    }

    const stats = fs.statSync(resolved);

    if (!stats.isFile()) {
        return { success: false, message: `${resolved} is not a file.` };
    }

    const size = stats.size;
    let content;

    try {
        if (size > safeMax) {
            const buffer = Buffer.allocUnsafe(safeMax);
            const fd = fs.openSync(resolved, "r");
            fs.readSync(fd, buffer, 0, safeMax, 0);
            fs.closeSync(fd);
            content = buffer.toString("utf8");
            content += `\n\n[... file truncated at ${safeMax} bytes. Total size: ${size} bytes ...]`;
        } else {
            content = fs.readFileSync(resolved, "utf8");
        }
    } catch (err) {
        return { success: false, message: `Could not read file: ${err.message}` };
    }

    return {
        success: true,
        filePath: resolved,
        content,
        sizeBytes: size,
        truncated: size > safeMax,
    };
}

// ─── List Directory ───────────────────────────────────────────────────────────

/**
 * List files and subdirectories in a folder.
 */
export function listDir(dirPath) {
    const { allowed, resolved, error } = guardPath(dirPath, "list");

    if (!allowed) return { success: false, message: error };

    if (!fs.existsSync(resolved)) {
        return { success: false, message: `Directory not found: ${resolved}` };
    }

    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
        return { success: false, message: `${resolved} is not a directory.` };
    }

    try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });

        const items = entries
            .filter((e) => !e.name.startsWith(".git") || e.name === ".gitignore")
            .map((e) => {
                const fullPath = path.join(resolved, e.name);
                const itemStats = e.isFile() ? fs.statSync(fullPath) : null;

                return {
                    name: e.name,
                    type: e.isDirectory() ? "directory" : "file",
                    sizeBytes: itemStats?.size ?? null,
                    extension: e.isFile() ? path.extname(e.name).toLowerCase() : null,
                };
            });

        return {
            success: true,
            dirPath: resolved,
            items,
            totalItems: items.length,
        };
    } catch (err) {
        return { success: false, message: `Could not list directory: ${err.message}` };
    }
}

// ─── Search Files ─────────────────────────────────────────────────────────────

/**
 * Search for files matching a name pattern inside an allowed directory.
 *
 * @param {string} basePath - Root directory to search within.
 * @param {string} pattern - Substring or exact filename to match.
 * @param {number} [maxResults]
 */
export function searchFiles(basePath, pattern, maxResults = 50) {
    const { allowed, resolved, error } = guardPath(basePath, "search");

    if (!allowed) return { success: false, message: error };

    if (!fs.existsSync(resolved)) {
        return { success: false, message: `Directory not found: ${resolved}` };
    }

    const results = [];
    const patternLower = pattern.toLowerCase();

    function walk(dir, depth = 0) {
        if (results.length >= maxResults || depth > 8) return;

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;

            const fullPath = path.join(dir, entry.name);

            if (entry.name.toLowerCase().includes(patternLower)) {
                results.push({
                    name: entry.name,
                    path: fullPath,
                    type: entry.isDirectory() ? "directory" : "file",
                });

                if (results.length >= maxResults) break;
            }

            if (entry.isDirectory()) {
                walk(fullPath, depth + 1);
            }
        }
    }

    walk(resolved);

    return {
        success: true,
        pattern,
        results,
        totalFound: results.length,
        capped: results.length >= maxResults,
    };
}

// ─── Write File ───────────────────────────────────────────────────────────────

/**
 * Write content to a file inside an allowed path.
 * Does NOT overwrite without the caller explicitly setting overwrite = true.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {object} options
 * @param {boolean} options.createDirs
 * @param {boolean} options.overwrite
 */
export function writeFile(filePath, content, { createDirs = true, overwrite = false } = {}) {
    const { allowed, resolved, error } = guardPath(filePath, "write");

    if (!allowed) return { success: false, message: error };

    // Block writing to sensitive filenames.
    const basename = path.basename(resolved);
    if (BLOCKED_FILENAMES.has(basename)) {
        return {
            success: false,
            message: `Writing to ${basename} is blocked to protect credentials.`,
        };
    }

    const exists = fs.existsSync(resolved);

    if (exists && !overwrite) {
        return {
            success: false,
            message: `File already exists: ${resolved}. Set overwrite=true to replace it.`,
            fileExists: true,
        };
    }

    try {
        if (createDirs) {
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
        }

        // Backup original if overwriting.
        if (exists && overwrite) {
            const backupPath = resolved + `.bak_${Date.now()}`;
            fs.copyFileSync(resolved, backupPath);
        }

        fs.writeFileSync(resolved, content, "utf8");

        return {
            success: true,
            filePath: resolved,
            message: exists ? `File updated: ${resolved}` : `File created: ${resolved}`,
            wasOverwrite: exists,
        };
    } catch (err) {
        return { success: false, message: `Could not write file: ${err.message}` };
    }
}

// ─── Create Directory ─────────────────────────────────────────────────────────

export function createDir(dirPath) {
    const { allowed, resolved, error } = guardPath(dirPath, "create");

    if (!allowed) return { success: false, message: error };

    try {
        fs.mkdirSync(resolved, { recursive: true });
        return { success: true, dirPath: resolved, message: `Directory created: ${resolved}` };
    } catch (err) {
        return { success: false, message: `Could not create directory: ${err.message}` };
    }
}
