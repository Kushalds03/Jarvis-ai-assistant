
/**
 * JARVIS Task Planner
 *
 * Converts natural-language requests into structured execution plans.
 * Uses AI (Gemini or Ollama) for understanding intent;
 * uses the validated action registry for all actual execution.
 */

import { ACTION_REGISTRY } from "../actions/registry.js";
import { JARVIS_CONFIG, resolveApp, resolveProject } from "../actions/config.js";

// ─── Intent Classification ────────────────────────────────────────────────────

const INTENT_PATTERNS = [
    // System
    {
        intent: "LOCK_PC",
        patterns: [/\block\s*(my\s*)?(?:pc|computer|screen|workstation)\b/i],
        actions: [{ actionId: "LOCK_PC", args: {} }],
    },
    {
        intent: "SHUTDOWN_PC",
        patterns: [/\b(shut\s*down|shutdown|power\s*off|turn\s*off)\s*(my\s*)?(?:pc|computer|system)\b/i],
        actions: null, // needs dynamic args (delay)
    },
    {
        intent: "RESTART_PC",
        patterns: [/\b(restart|reboot|reset)\s*(my\s*)?(?:pc|computer|system)\b/i],
        actions: null,
    },
    {
        intent: "CANCEL_SHUTDOWN",
        patterns: [/\bcancel\s*(the\s*)?(shutdown|restart|reboot|power\s*off)\b/i],
        actions: [{ actionId: "CANCEL_SHUTDOWN", args: {} }],
    },
    {
        intent: "GET_SYSTEM_INFO",
        patterns: [
            /\b(what\s*time|current\s*time|what('s|\s*is)\s*the\s*time)\b/i,
            /\bsystem\s*(info|status|information)\b/i,
            /\bhow\s*(much|many)\s*(ram|memory|cpu)\b/i,
        ],
        actions: [{ actionId: "GET_SYSTEM_INFO", args: {} }],
    },

    // Applications
    {
        intent: "OPEN_APP",
        patterns: [
            /\b(open|launch|start|run|show)\s+(?!my\s*files)(?!folder)(?!dashboard)(.+)/i,
            /\bbring\s*up\s+(.+)/i,
        ],
        actions: null, // dynamic – extract app name
    },
    {
        intent: "OPEN_DASHBOARD",
        patterns: [/\bopen\s*(my\s*)?(dashboard|jarvis\s*dashboard|ui|interface)\b/i],
        actions: [{ actionId: "OPEN_URL", args: { url: "http://localhost:5173" } }],
    },
    {
        intent: "OPEN_FOLDER",
        patterns: [
            /\bopen\s*(my\s*)?(folder|directory|files?\s*in|project\s*folder)\b/i,
            /\bexplore\s+(.+)/i,
        ],
        actions: null,
    },

    // Git
    {
        intent: "GIT_STATUS",
        patterns: [
            /\b(git\s*status|repo\s*status|check\s*(my\s*)?(repo|repository|git|changes))\b/i,
            /\b(any\s*)?uncommitted\s*changes\b/i,
        ],
        actions: [{ actionId: "GIT_STATUS", args: {} }],
    },
    {
        intent: "GIT_DIFF",
        patterns: [/\b(show\s*)?(git\s*)?diff\b/i, /\bwhat\s*(have\s*)?i\s*changed\b/i],
        actions: [{ actionId: "GIT_DIFF", args: { staged: false } }],
    },
    {
        intent: "GIT_COMMIT",
        patterns: [/\bcommit\s*(my\s*)?(changes|code|work)\b/i],
        actions: null, // needs commit message
    },
    {
        intent: "GIT_PUSH",
        patterns: [/\bpush\s*(my\s*)?(changes|code|commits?)?\s*(to\s*(github|remote|origin))?\b/i],
        actions: null,
    },
    {
        intent: "GITHUB_AUTH_STATUS",
        patterns: [/\b(github|gh)\s*(auth|login|authentication|connected|status)\b/i],
        actions: [{ actionId: "GITHUB_AUTH_STATUS", args: {} }],
    },

    // Files
    {
        intent: "READ_FILE",
        patterns: [/\b(read|show|open|view|display)\s*(the\s*)?file\s+(.+)/i],
        actions: null,
    },
    {
        intent: "LIST_DIR",
        patterns: [
            /\b(list|show)\s*(me\s*)?(the\s*)?(files?|contents?|folder)\b/i,
            /\bwhat\s*(files?\s*)?(are\s*)?in\b/i,
        ],
        actions: null,
    },
    {
        intent: "SEARCH_FILES",
        patterns: [/\bfind\s*(the\s*)?file\s+(.+)/i, /\bsearch\s*(for\s*)?(.+)\s*file/i],
        actions: null,
    },
];

// ─── Plan Building ────────────────────────────────────────────────────────────

/**
 * Attempt to classify intent and build a plan from patterns alone.
 * Returns null when the request needs AI planning.
 */
export function classifyIntent(message) {
    const text = message.trim();

    for (const rule of INTENT_PATTERNS) {
        for (const pattern of rule.patterns) {
            const match = text.match(pattern);

            if (!match) continue;

            // Static actions (no dynamic arg extraction needed).
            if (rule.actions) {
                return {
                    intent: rule.intent,
                    confidence: "pattern",
                    steps: rule.actions,
                    rawMatch: match[0],
                };
            }

            // Dynamic — extract relevant arguments.
            return buildDynamicPlan(rule.intent, text, match);
        }
    }

    return null; // Needs AI planning.
}

function buildDynamicPlan(intent, text, match) {
    switch (intent) {
        case "OPEN_APP": {
            // Extract what comes after "open", "launch", "start", etc.
            const appQuery =
                match[2]?.trim() ||
                text.replace(/^(open|launch|start|run|show|bring up)\s+/i, "").trim();

            const app = resolveApp(appQuery);

            if (app) {
                return {
                    intent,
                    confidence: "pattern",
                    steps: [{ actionId: "OPEN_APP", args: { appKey: app.key } }],
                    appName: app.name,
                };
            }

            return null; // Unknown app — fall back to AI.
        }

        case "OPEN_FOLDER": {
            const project = resolveProject(text);

            if (project) {
                return {
                    intent,
                    confidence: "pattern",
                    steps: [{ actionId: "OPEN_FOLDER", args: { folderPath: project.path } }],
                };
            }

            return null;
        }

        case "SHUTDOWN_PC": {
            const delayMatch = text.match(/(\d+)\s*(second|sec|minute|min|hour|hr)/i);
            let delaySecs = JARVIS_CONFIG.system.defaultShutdownDelaySecs;

            if (delayMatch) {
                const value = parseInt(delayMatch[1], 10);
                const unit = delayMatch[2].toLowerCase();
                if (unit.startsWith("min")) delaySecs = value * 60;
                else if (unit.startsWith("hour") || unit.startsWith("hr")) delaySecs = value * 3600;
                else delaySecs = value;
            }

            return {
                intent,
                confidence: "pattern",
                requiresConfirmation: true,
                confirmationPrompt:
                    delaySecs === 0
                        ? "Shut down the PC immediately?"
                        : `Schedule shutdown in ${delaySecs} seconds?`,
                steps: [{ actionId: "SHUTDOWN_PC", args: { delaySecs } }],
            };
        }

        case "RESTART_PC": {
            const delayMatch = text.match(/(\d+)\s*(second|sec|minute|min)/i);
            let delaySecs = JARVIS_CONFIG.system.defaultShutdownDelaySecs;

            if (delayMatch) {
                const value = parseInt(delayMatch[1], 10);
                const unit = delayMatch[2].toLowerCase();
                delaySecs = unit.startsWith("min") ? value * 60 : value;
            }

            return {
                intent,
                confidence: "pattern",
                requiresConfirmation: true,
                confirmationPrompt: `Schedule restart in ${delaySecs} seconds?`,
                steps: [{ actionId: "RESTART_PC", args: { delaySecs } }],
            };
        }

        case "GIT_COMMIT": {
            const msgMatch = text.match(
                /commit\s+(?:with\s+(?:message\s+)?)?["""]?(.+?)["""]?\s*$/i
            );
            const message = msgMatch?.[1]?.trim() || "JARVIS: automated commit";

            return {
                intent,
                confidence: "pattern",
                requiresConfirmation: true,
                confirmationPrompt: `Commit with message: "${message}"?`,
                steps: [
                    { actionId: "GIT_DIFF", args: { staged: false } },
                    { actionId: "GIT_COMMIT", args: { message, addAll: true } },
                ],
            };
        }

        case "GIT_PUSH": {
            return {
                intent,
                confidence: "pattern",
                requiresConfirmation: true,
                confirmationPrompt: "Push current branch to origin?",
                steps: [
                    { actionId: "GIT_DIFF", args: { staged: true } },
                    { actionId: "GIT_PUSH", args: { remote: "origin" } },
                ],
            };
        }

        default:
            return null;
    }
}

// ─── AI-Based Planning ────────────────────────────────────────────────────────

/**
 * Build a planning prompt that asks the AI to output a structured JSON plan.
 *
 * @param {string} message - User's natural language request.
 * @param {object} context - { memories, gitStatus, projectList }
 */
export function buildPlanningPrompt(message, context = {}) {
    const availableActions = Object.keys(ACTION_REGISTRY).join(", ");
    const availableApps = Object.keys(JARVIS_CONFIG.applications).join(", ");
    const availableProjects = Object.keys(JARVIS_CONFIG.projects).join(", ");

    return [
        "You are the JARVIS task planner. Your job is to convert user requests into structured JSON execution plans.",
        "",
        "Available actions: " + availableActions,
        "Available app keys: " + availableApps,
        "Available project keys: " + availableProjects,
        "",
        "User context:",
        context.memories?.length
            ? "Known facts: " + context.memories.map((m) => m.content).join("; ")
            : "No saved memories.",
        "",
        "Respond ONLY with valid JSON in this exact format:",
        `{`,
        `  "intent": "<one-line description>",`,
        `  "requiresConfirmation": false,`,
        `  "confirmationPrompt": null,`,
        `  "steps": [`,
        `    { "actionId": "<ACTION_ID>", "args": { ... } }`,
        `  ],`,
        `  "reply": "<friendly spoken reply to the user acknowledging the task>"`,
        `}`,
        "",
        "Rules:",
        "- Use only action IDs from the list above.",
        "- Never include arbitrary shell commands.",
        "- Set requiresConfirmation: true for shutdown, restart, commit, push, delete operations.",
        "- If the request is unclear or cannot be handled, return steps: [] and reply with an explanation.",
        "",
        "User request: " + message,
    ].join("\n");
}

/**
 * Parse AI planning response, extracting JSON even if the model wraps it in markdown.
 */
export function parsePlanningResponse(rawResponse) {
    // Strip markdown code fences if present.
    const stripped = rawResponse
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/\s*```\s*$/m, "")
        .trim();

    try {
        const plan = JSON.parse(stripped);

        // Basic schema validation.
        if (!Array.isArray(plan.steps)) {
            return { valid: false, error: "Plan missing steps array." };
        }

        return { valid: true, plan };
    } catch (err) {
        return { valid: false, error: `Failed to parse plan JSON: ${err.message}` };
    }
}
