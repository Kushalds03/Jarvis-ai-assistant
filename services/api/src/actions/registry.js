
/**
 * JARVIS Action Registry
 *
 * Every action JARVIS can execute is defined and validated here.
 * AI-generated text NEVER becomes raw shell commands.
 * All arguments are validated before any handler is called.
 */

// ─── Permission Categories ─────────────────────────────────────────────────

export const Permission = Object.freeze({
    /** Safe, reversible, automatic. */
    A_ORDINARY: "A_ORDINARY",
    /** Consequential – requires confirmation in Category B policy. */
    B_CONSEQUENTIAL: "B_CONSEQUENTIAL",
    /** High-risk – requires explicit user approval every time. */
    C_HIGHRISK: "C_HIGHRISK",
});

// ─── Action Registry ──────────────────────────────────────────────────────

/**
 * Each entry maps an action ID to its definition.
 *
 * schema: Record<paramName, { type, required, pattern?, min?, max?, allowedValues? }>
 */
export const ACTION_REGISTRY = {
    // ── Application Actions ─────────────────────────────────────────────────
    OPEN_APP: {
        id: "OPEN_APP",
        description: "Open a registered application or URL.",
        permission: Permission.A_ORDINARY,
        schema: {
            appKey: { type: "string", required: true },
            args: { type: "array", required: false },
        },
    },
    OPEN_FOLDER: {
        id: "OPEN_FOLDER",
        description: "Open a folder in File Explorer.",
        permission: Permission.A_ORDINARY,
        schema: {
            folderPath: { type: "string", required: true },
        },
    },
    OPEN_URL: {
        id: "OPEN_URL",
        description: "Open a URL in the default browser.",
        permission: Permission.A_ORDINARY,
        schema: {
            url: { type: "string", required: true, pattern: /^https?:\/\//i },
        },
    },

    // ── File Operations ─────────────────────────────────────────────────────
    READ_FILE: {
        id: "READ_FILE",
        description: "Read and return the contents of a text file.",
        permission: Permission.A_ORDINARY,
        schema: {
            filePath: { type: "string", required: true },
            maxBytes: { type: "number", required: false, min: 1, max: 500_000 },
        },
    },
    LIST_DIR: {
        id: "LIST_DIR",
        description: "List files and directories inside a folder.",
        permission: Permission.A_ORDINARY,
        schema: {
            dirPath: { type: "string", required: true },
        },
    },
    SEARCH_FILES: {
        id: "SEARCH_FILES",
        description: "Search for files by name pattern inside allowed directories.",
        permission: Permission.A_ORDINARY,
        schema: {
            basePath: { type: "string", required: true },
            pattern: { type: "string", required: true },
        },
    },
    WRITE_FILE: {
        id: "WRITE_FILE",
        description: "Write or overwrite a file with provided content.",
        permission: Permission.B_CONSEQUENTIAL,
        schema: {
            filePath: { type: "string", required: true },
            content: { type: "string", required: true },
            createDirs: { type: "boolean", required: false },
        },
    },
    CREATE_DIR: {
        id: "CREATE_DIR",
        description: "Create a directory (and intermediate directories).",
        permission: Permission.A_ORDINARY,
        schema: {
            dirPath: { type: "string", required: true },
        },
    },
    DELETE_FILE: {
        id: "DELETE_FILE",
        description: "Delete a single file.",
        permission: Permission.C_HIGHRISK,
        schema: {
            filePath: { type: "string", required: true },
        },
    },

    // ── System Actions ──────────────────────────────────────────────────────
    LOCK_PC: {
        id: "LOCK_PC",
        description: "Lock the Windows workstation immediately.",
        permission: Permission.A_ORDINARY,
        schema: {},
    },
    SHUTDOWN_PC: {
        id: "SHUTDOWN_PC",
        description: "Shut down the PC, optionally after a delay.",
        permission: Permission.B_CONSEQUENTIAL,
        schema: {
            delaySecs: { type: "number", required: false, min: 0, max: 3600 },
            force: { type: "boolean", required: false },
        },
    },
    RESTART_PC: {
        id: "RESTART_PC",
        description: "Restart the PC, optionally after a delay.",
        permission: Permission.B_CONSEQUENTIAL,
        schema: {
            delaySecs: { type: "number", required: false, min: 0, max: 3600 },
            force: { type: "boolean", required: false },
        },
    },
    CANCEL_SHUTDOWN: {
        id: "CANCEL_SHUTDOWN",
        description: "Cancel a pending scheduled shutdown or restart.",
        permission: Permission.A_ORDINARY,
        schema: {},
    },
    GET_SYSTEM_INFO: {
        id: "GET_SYSTEM_INFO",
        description: "Return basic system information (uptime, time, OS).",
        permission: Permission.A_ORDINARY,
        schema: {},
    },

    // ── Git / GitHub Actions ────────────────────────────────────────────────
    GIT_STATUS: {
        id: "GIT_STATUS",
        description: "Show git status for a project.",
        permission: Permission.A_ORDINARY,
        schema: {
            projectKey: { type: "string", required: false },
        },
    },
    GIT_DIFF: {
        id: "GIT_DIFF",
        description: "Show git diff (unstaged or staged) for a project.",
        permission: Permission.A_ORDINARY,
        schema: {
            projectKey: { type: "string", required: false },
            staged: { type: "boolean", required: false },
        },
    },
    GIT_LOG: {
        id: "GIT_LOG",
        description: "Show recent git commits for a project.",
        permission: Permission.A_ORDINARY,
        schema: {
            projectKey: { type: "string", required: false },
            limit: { type: "number", required: false, min: 1, max: 50 },
        },
    },
    GIT_BRANCH: {
        id: "GIT_BRANCH",
        description: "Create or list branches.",
        permission: Permission.B_CONSEQUENTIAL,
        schema: {
            projectKey: { type: "string", required: false },
            action: { type: "string", required: true, allowedValues: ["list", "create", "checkout"] },
            name: { type: "string", required: false },
        },
    },
    GIT_COMMIT: {
        id: "GIT_COMMIT",
        description: "Stage all changes and commit with a message.",
        permission: Permission.B_CONSEQUENTIAL,
        schema: {
            projectKey: { type: "string", required: false },
            message: { type: "string", required: true },
            addAll: { type: "boolean", required: false },
        },
    },
    GIT_PUSH: {
        id: "GIT_PUSH",
        description: "Push committed changes to the configured remote.",
        permission: Permission.B_CONSEQUENTIAL,
        schema: {
            projectKey: { type: "string", required: false },
            remote: { type: "string", required: false },
            branch: { type: "string", required: false },
        },
    },
    GIT_PULL: {
        id: "GIT_PULL",
        description: "Pull latest changes from remote.",
        permission: Permission.A_ORDINARY,
        schema: {
            projectKey: { type: "string", required: false },
        },
    },
    GIT_INIT: {
        id: "GIT_INIT",
        description: "Initialise a new git repository.",
        permission: Permission.B_CONSEQUENTIAL,
        schema: {
            projectKey: { type: "string", required: false },
            dirPath: { type: "string", required: false },
        },
    },
    GITHUB_CREATE_REPO: {
        id: "GITHUB_CREATE_REPO",
        description: "Create a new GitHub repository using the gh CLI.",
        permission: Permission.B_CONSEQUENTIAL,
        schema: {
            name: { type: "string", required: true },
            private: { type: "boolean", required: false },
            description: { type: "string", required: false },
        },
    },
    GITHUB_AUTH_STATUS: {
        id: "GITHUB_AUTH_STATUS",
        description: "Check GitHub CLI authentication status.",
        permission: Permission.A_ORDINARY,
        schema: {},
    },

    // ── Development Actions ─────────────────────────────────────────────────
    RUN_DEV_COMMAND: {
        id: "RUN_DEV_COMMAND",
        description: "Run an approved development command inside a project directory.",
        permission: Permission.B_CONSEQUENTIAL,
        schema: {
            projectKey: { type: "string", required: true },
            commandType: {
                type: "string",
                required: true,
                allowedValues: ["test", "build", "lint", "typecheck", "install"],
            },
        },
    },
};

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate an action call against the registry schema.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateAction(actionId, args = {}) {
    const definition = ACTION_REGISTRY[actionId];

    if (!definition) {
        return { valid: false, error: `Unknown action: ${actionId}` };
    }

    for (const [paramName, rules] of Object.entries(definition.schema)) {
        const value = args[paramName];

        if (rules.required && (value === undefined || value === null || value === "")) {
            return {
                valid: false,
                error: `Missing required parameter: ${paramName}`,
            };
        }

        if (value === undefined || value === null) continue;

        if (rules.type === "string" && typeof value !== "string") {
            return { valid: false, error: `${paramName} must be a string` };
        }

        if (rules.type === "number" && typeof value !== "number") {
            return { valid: false, error: `${paramName} must be a number` };
        }

        if (rules.type === "boolean" && typeof value !== "boolean") {
            return { valid: false, error: `${paramName} must be a boolean` };
        }

        if (rules.type === "array" && !Array.isArray(value)) {
            return { valid: false, error: `${paramName} must be an array` };
        }

        if (rules.pattern && typeof value === "string" && !rules.pattern.test(value)) {
            return { valid: false, error: `${paramName} has an invalid format` };
        }

        if (rules.min !== undefined && typeof value === "number" && value < rules.min) {
            return { valid: false, error: `${paramName} must be at least ${rules.min}` };
        }

        if (rules.max !== undefined && typeof value === "number" && value > rules.max) {
            return { valid: false, error: `${paramName} must be at most ${rules.max}` };
        }

        if (
            rules.allowedValues &&
            !rules.allowedValues.includes(value)
        ) {
            return {
                valid: false,
                error: `${paramName} must be one of: ${rules.allowedValues.join(", ")}`,
            };
        }
    }

    return { valid: true };
}

/**
 * Return the permission category for a given action.
 */
export function getActionPermission(actionId) {
    return ACTION_REGISTRY[actionId]?.permission ?? null;
}
