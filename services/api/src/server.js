
/**
 * JARVIS API Server — Enhanced
 *
 * Endpoints:
 *   GET  /api/health           — service health + provider info
 *   GET  /api/memories         — list all memories
 *   POST /api/memories         — create a memory
 *   DELETE /api/memories/:id   — delete a memory
 *   POST /api/chat             — conversational AI (Ollama or Gemini)
 *   POST /api/agent            — UNDERSTAND→PLAN→EXECUTE pipeline
 *   POST /api/actions/execute  — execute a single validated action
 *   GET  /api/actions/list     — list registered actions
 *   GET  /api/provider         — current AI provider
 *   POST /api/provider         — switch AI provider
 *   GET  /api/system/info      — system information
 *   GET  /api/approvals        — pending approval requests
 *   POST /api/approvals/:id/resolve — approve or reject a pending action
 *   GET  /api/voice/status     — voice service heartbeat cache
 *   POST /api/voice/heartbeat  — voice service registration
 *   GET  /api/git/status       — git status for configured projects
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

import {
    saveMemory,
    searchMemories,
    listMemories,
    removeMemory,
} from "./memory.js";

import { ACTION_REGISTRY, validateAction, getActionPermission, Permission } from "./actions/registry.js";
import { JARVIS_CONFIG } from "./actions/config.js";
import { classifyIntent, buildPlanningPrompt, parsePlanningResponse } from "./agent/planner.js";
import { executeStep, executePlan } from "./agent/executor.js";
import { getSystemInfo } from "./actions/system.js";
import { gitStatus } from "./actions/git.js";
import { listAvailableApps } from "./actions/apps.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const app = express();
const PORT = 3000;

const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_MODEL = "qwen2.5:3b";
const GEMINI_MODEL = "gemini-2.0-flash";
const REQUEST_TIMEOUT_MS = 60_000;

// ─── AI Providers ─────────────────────────────────────────────────────────────

// Mutable current provider — can be switched via the API.
let currentProvider = "ollama"; // 'ollama' | 'gemini'

// Initialise Gemini only when a key is available.
let geminiAI = null;

if (process.env.GEMINI_API_KEY) {
    try {
        geminiAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        console.log("Gemini AI initialised.");
    } catch (err) {
        console.error("Failed to initialise Gemini:", err.message);
    }
} else {
    console.warn("GEMINI_API_KEY not set — Gemini provider unavailable.");
}

// ─── Approval Queue ───────────────────────────────────────────────────────────

const approvalQueue = new Map(); // id → { id, prompt, plan, createdAt, resolve, reject }
let approvalCounter = 1;

function createApprovalRequest(prompt, plan) {
    const id = String(approvalCounter++);
    return new Promise((resolve, reject) => {
        approvalQueue.set(id, {
            id,
            prompt,
            plan,
            createdAt: new Date().toISOString(),
            resolve,
            reject,
        });
    });
}

// ─── Voice Service State ──────────────────────────────────────────────────────

let voiceServiceState = {
    online: false,
    lastHeartbeat: null,
    status: "offline",
    wakeWordActive: false,
    listening: false,
    muted: false,
};

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
    cors({
        origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    })
);

app.use(express.json({ limit: "64kb" }));

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
    res.json({
        name: "JARVIS",
        status: "online",
        message: "JARVIS backend is running.",
        provider: currentProvider,
        providers: {
            ollama: { available: true, model: OLLAMA_MODEL },
            gemini: { available: !!geminiAI, model: GEMINI_MODEL },
        },
        memory: "SQLite",
        version: "0.5.0",
    });
});

// ─── Provider ─────────────────────────────────────────────────────────────────

app.get("/api/provider", (_req, res) => {
    res.json({
        current: currentProvider,
        providers: {
            ollama: { available: true, model: OLLAMA_MODEL },
            gemini: { available: !!geminiAI, model: GEMINI_MODEL },
        },
    });
});

app.post("/api/provider", (req, res) => {
    const { provider } = req.body ?? {};

    if (!["ollama", "gemini"].includes(provider)) {
        return res.status(400).json({ error: "Provider must be 'ollama' or 'gemini'." });
    }

    if (provider === "gemini" && !geminiAI) {
        return res.status(400).json({
            error: "Gemini is not available. Add GEMINI_API_KEY to services/api/.env.",
        });
    }

    currentProvider = provider;

    return res.json({ provider: currentProvider, message: `Switched to ${provider}.` });
});

// ─── System Info ──────────────────────────────────────────────────────────────

app.get("/api/system/info", async (_req, res) => {
    try {
        const info = await getSystemInfo();
        res.json(info);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Voice Service ────────────────────────────────────────────────────────────

app.get("/api/voice/status", (_req, res) => {
    // Mark offline if no heartbeat in 15 seconds.
    const age = voiceServiceState.lastHeartbeat
        ? Date.now() - new Date(voiceServiceState.lastHeartbeat).getTime()
        : Infinity;

    if (age > 15_000) {
        voiceServiceState.online = false;
        voiceServiceState.status = "offline";
    }

    res.json(voiceServiceState);
});

app.post("/api/voice/heartbeat", (req, res) => {
    voiceServiceState = {
        online: true,
        lastHeartbeat: new Date().toISOString(),
        status: req.body?.status ?? "idle",
        wakeWordActive: req.body?.wakeWordActive ?? false,
        listening: req.body?.listening ?? false,
        muted: req.body?.muted ?? false,
    };

    res.json({ received: true });
});

// ─── Actions ──────────────────────────────────────────────────────────────────

app.get("/api/actions/list", (_req, res) => {
    const actions = Object.entries(ACTION_REGISTRY).map(([id, def]) => ({
        id,
        description: def.description,
        permission: def.permission,
        schema: def.schema,
    }));

    const apps = listAvailableApps();

    res.json({ actions, apps });
});

app.post("/api/actions/execute", async (req, res) => {
    const { actionId, args = {} } = req.body ?? {};

    if (!actionId) {
        return res.status(400).json({ error: "actionId is required." });
    }

    const validation = validateAction(actionId, args);
    if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
    }

    const permission = getActionPermission(actionId);

    // High-risk actions cannot be executed directly from the API.
    if (permission === Permission.C_HIGHRISK) {
        return res.status(403).json({
            error: "This action requires explicit user approval and cannot be executed directly.",
            permission,
        });
    }

    try {
        const result = await executeStep({ actionId, args });
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── Approvals ────────────────────────────────────────────────────────────────

app.get("/api/approvals", (_req, res) => {
    const pending = [...approvalQueue.values()].map(({ id, prompt, plan, createdAt }) => ({
        id,
        prompt,
        plan,
        createdAt,
    }));

    res.json({ pending });
});

app.post("/api/approvals/:id/resolve", (req, res) => {
    const { id } = req.params;
    const { approved } = req.body ?? {};
    const entry = approvalQueue.get(id);

    if (!entry) {
        return res.status(404).json({ error: "Approval request not found or already resolved." });
    }

    approvalQueue.delete(id);

    if (approved) {
        entry.resolve(true);
        return res.json({ resolved: true, approved: true });
    } else {
        entry.reject(new Error("User rejected the action."));
        return res.json({ resolved: true, approved: false });
    }
});

// ─── Git Status ───────────────────────────────────────────────────────────────

app.get("/api/git/status", async (_req, res) => {
    try {
        const status = await gitStatus("jarvis");
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Agent ────────────────────────────────────────────────────────────────────

app.post("/api/agent", async (req, res) => {
    const message = req.body?.message;

    if (typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message is required." });
    }

    const cleanMessage = message.trim();

    // 1. Try fast pattern-based classification.
    const patternPlan = classifyIntent(cleanMessage);

    let plan = patternPlan;
    let aiReply = null;

    // 2. If no pattern matched, ask the AI to plan.
    if (!plan) {
        const memories = listMemories().slice(0, 10);
        const prompt = buildPlanningPrompt(cleanMessage, { memories });

        try {
            const rawResponse = await callAI(prompt, []);
            const parsed = parsePlanningResponse(rawResponse);

            if (parsed.valid) {
                plan = parsed.plan;
                aiReply = parsed.plan.reply;
            } else {
                // AI returned something we couldn't parse — fall back to chat.
                return res.json({
                    reply: rawResponse,
                    mode: "chat",
                    planningFailed: true,
                });
            }
        } catch (err) {
            return res.status(500).json({ error: `AI planning failed: ${err.message}` });
        }
    }

    // 3. Check whether user confirmation is needed.
    if (plan.requiresConfirmation) {
        const approvalId = String(approvalCounter++);

        approvalQueue.set(approvalId, {
            id: approvalId,
            prompt: plan.confirmationPrompt,
            plan,
            createdAt: new Date().toISOString(),
            resolve: null,
            reject: null,
        });

        return res.json({
            reply:
                `I need your approval, Sir. ${plan.confirmationPrompt} ` +
                `Reply to approval request #${approvalId} in the dashboard.`,
            requiresConfirmation: true,
            approvalId,
            plan,
            mode: "approval",
        });
    }

    // 4. Execute the plan immediately (no confirmation needed).
    if (!plan.steps || plan.steps.length === 0) {
        return res.json({
            reply: aiReply || plan.reply || "I couldn't determine how to handle that request.",
            mode: "no-action",
        });
    }

    try {
        const executionResult = await executePlan(plan);
        const resultSummary = buildAgentReply(cleanMessage, plan, executionResult);

        return res.json({
            reply: resultSummary,
            mode: "action",
            plan,
            executionResult,
        });
    } catch (err) {
        return res.status(500).json({ error: `Execution failed: ${err.message}` });
    }
});

function buildAgentReply(message, plan, result) {
    if (!result.failed) {
        // Build specific replies for known intents.
        const firstResult = result.results[0]?.result;

        switch (plan.intent) {
            case "GET_SYSTEM_INFO":
                if (firstResult) {
                    return (
                        `It is currently ${firstResult.time} on ${firstResult.date}. ` +
                        `System uptime is ${firstResult.uptime}. ` +
                        `You have ${firstResult.freeRamGB} GB of RAM available out of ${firstResult.totalRamGB} GB total, Sir.`
                    );
                }
                break;

            case "GIT_STATUS":
                if (firstResult?.status) {
                    return (
                        `Git status for the JARVIS project, Sir:\n\n` +
                        `Branch: ${firstResult.branch}\n` +
                        firstResult.status +
                        (firstResult.recentCommits?.length
                            ? `\n\nRecent commits:\n${firstResult.recentCommits.join("\n")}`
                            : "")
                    );
                }
                break;

            case "GITHUB_AUTH_STATUS":
                if (firstResult?.authenticated) {
                    return `GitHub CLI is authenticated, Sir. ${firstResult.details}`;
                }
                return `GitHub CLI is not authenticated, Sir. Run "gh auth login" in a terminal to connect.`;

            case "CANCEL_SHUTDOWN":
                return firstResult?.success
                    ? "The pending shutdown has been cancelled, Sir."
                    : `No shutdown was scheduled, Sir.`;

            case "OPEN_APP":
                return plan.appName
                    ? `Opening ${plan.appName} for you, Sir.`
                    : "Done, Sir. The application is opening.";

            case "LOCK_PC":
                return "Locking your workstation now, Sir.";

            default:
                break;
        }

        return result.summary || "Done, Sir.";
    }

    return `I encountered an issue, Sir. ${result.summary}`;
}

// ─── Memory Management ────────────────────────────────────────────────────────

app.get("/api/memories", (_req, res) => {
    try {
        return res.json({ memories: listMemories() });
    } catch (error) {
        console.error("Failed to list memories:", error.message);
        return res.status(500).json({ error: "Could not retrieve saved memories." });
    }
});

app.post("/api/memories", (req, res) => {
    const { content, category = "general" } = req.body ?? {};

    if (typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ error: "Memory content is required." });
    }

    if (content.trim().length > 1000) {
        return res.status(400).json({ error: "Memory must be 1000 characters or fewer." });
    }

    if (
        typeof category !== "string" ||
        !category.trim() ||
        category.trim().length > 100
    ) {
        return res.status(400).json({ error: "Category must contain 1–100 characters." });
    }

    try {
        const id = saveMemory(content.trim(), category.trim());
        return res.status(201).json({ id, content: content.trim(), category: category.trim() });
    } catch (error) {
        console.error("Failed to save memory:", error.message);
        return res.status(500).json({ error: "Could not save this memory." });
    }
});

app.delete("/api/memories/:id", (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid memory ID." });
    }

    try {
        const deleted = removeMemory(id);

        if (!deleted) {
            return res.status(404).json({ error: "Memory not found." });
        }

        return res.json({ success: true, message: "Memory deleted successfully." });
    } catch (error) {
        console.error("Failed to delete memory:", error.message);
        return res.status(500).json({ error: "Could not delete this memory." });
    }
});

// ─── Chat API ─────────────────────────────────────────────────────────────────

function detectMemoryCommand(message) {
    const text = message.trim();
    const rememberMatch = text.match(/^(?:jarvis[, ]+)?remember that\s+([\s\S]+)$/i);

    if (rememberMatch) {
        const facts = rememberMatch[1]
            .trim()
            .split(/\s+(?=(?:jarvis[, ]+)?remember that\s+)/i)
            .map((f) =>
                f
                    .replace(/^(?:jarvis[, ]+)?remember that\s+/i, "")
                    .trim()
                    .replace(/[.!?]+$/, "")
                    .trim()
            )
            .filter(Boolean);

        return { action: "remember", facts };
    }

    const forgetMatch = text.match(/^(?:jarvis[, ]+)?forget that\s+(.+?)[.!?]*$/i);
    if (forgetMatch) return { action: "forget", content: forgetMatch[1].trim() };

    const forgetPrefMatch = text.match(/^(?:jarvis[, ]+)?forget\s+(?:my\s+)?(.+?)[.!?]*$/i);
    if (
        forgetPrefMatch &&
        !/^(that|it|everything|all memories|all my memories)$/i.test(forgetPrefMatch[1].trim())
    ) {
        return { action: "forget", content: forgetPrefMatch[1].trim() };
    }

    return null;
}

function isMemorySummaryRequest(message) {
    return (
        /\bwhat do you remember about me\b/i.test(message) ||
        /\bwhat do you know about me\b/i.test(message) ||
        /\bwhat have you remembered\b/i.test(message) ||
        /\bshow (?:me )?(?:all )?(?:my )?(?:saved )?memories\b/i.test(message) ||
        /\blist (?:all )?(?:my )?(?:saved )?memories\b/i.test(message) ||
        /\bwhat (?:information|facts) have you saved about me\b/i.test(message)
    );
}

function getRelevantMemories(message) {
    const asksAboutMemory =
        /\b(remember|memory|memories|favorite|favourite|prefer|preferences|what do you know about me|what have i told you)\b/i.test(
            message
        );

    if (asksAboutMemory) return listMemories().slice(0, 20);

    const stopWords = new Set([
        "what", "which", "when", "where", "who", "why", "how",
        "does", "did", "are", "was", "were", "the", "and", "for",
        "with", "from", "have", "has", "you", "your", "this",
        "that", "tell", "please", "can", "could", "would", "about",
        "know", "color", "colour", "favorite", "favourite",
        "what's", "whats", "mine", "jarvis", "remember",
    ]);

    const keywords = message
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !stopWords.has(w))
        .slice(0, 6);

    const results = new Map();

    for (const keyword of keywords) {
        for (const memory of searchMemories(keyword)) {
            results.set(memory.id, memory);
        }
    }

    if (/\b(my|favorite|favourite|prefer|preference)\b/i.test(message)) {
        for (const memory of listMemories()) {
            if (["preference", "personal"].includes(memory.category)) {
                results.set(memory.id, memory);
            }
        }
    }

    return [...results.values()].slice(0, 10);
}

/**
 * Call the current AI provider with a list of OpenAI-style messages.
 */
async function callAI(systemPrompt, messages) {
    if (currentProvider === "gemini" && geminiAI) {
        return callGemini(systemPrompt, messages);
    }

    return callOllama(systemPrompt, messages);
}

async function callOllama(systemPrompt, messages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;

    try {
        response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                messages: [
                    { role: "system", content: systemPrompt },
                    ...messages,
                ],
                stream: false,
            }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Ollama error ${response.status}: ${details}`);
    }

    const result = await response.json();
    const reply = result.message?.content?.trim();

    if (!reply) throw new Error("Ollama returned an empty response.");

    return reply;
}

async function callGemini(systemPrompt, messages) {
    // Convert OpenAI-style messages to Gemini content format.
    const contents = messages.map((msg) => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
    }));

    // Prepend the system prompt as an initial user turn if contents is empty.
    if (contents.length === 0) {
        contents.push({ role: "user", parts: [{ text: systemPrompt }] });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await geminiAI.models.generateContent({
            model: GEMINI_MODEL,
            contents,
            config: {
                systemInstruction: systemPrompt,
                maxOutputTokens: 2048,
                temperature: 0.7,
            },
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) throw new Error("Gemini returned an empty response.");

        return text;
    } finally {
        clearTimeout(timeout);
    }
}

app.post("/api/chat", async (req, res) => {
    try {
        const message = req.body?.message;

        if (typeof message !== "string" || !message.trim()) {
            return res.status(400).json({ error: "Please provide a message." });
        }

        if (message.length > 4000) {
            return res.status(400).json({ error: "Message must be 4000 characters or fewer." });
        }

        const cleanedMessage = message.trim();
        const memoryCommand = detectMemoryCommand(cleanedMessage);

        if (memoryCommand?.action === "remember") {
            const { facts } = memoryCommand;

            if (!facts.length || facts.some((f) => !f || f.length > 1000)) {
                return res.status(400).json({ error: "Each memory must contain 1–1000 characters." });
            }

            const saved = facts.map((content) => ({
                id: saveMemory(content, "general"),
                content,
            }));

            const reply =
                saved.length === 1
                    ? `Noted, Sir. I'll remember that: ${saved[0].content}`
                    : `Understood, Sir. I've saved ${saved.length} facts:\n` +
                    saved.map((item) => `- ${item.content}`).join("\n");

            return res.json({ reply, memorySaved: true, memoriesSaved: saved });
        }

        if (memoryCommand?.action === "forget") {
            const requested = memoryCommand.content
                .toLowerCase()
                .replace(/[.!?]+$/, "")
                .trim();

            const normalize = (v) =>
                v
                    .toLowerCase()
                    .replace(/[^\p{L}\p{N}\s]/gu, " ")
                    .replace(/\s+/g, " ")
                    .trim();

            const normalizedRequest = normalize(requested);
            const allMemories = listMemories();

            let matches = allMemories.filter(
                (m) => normalize(m.content) === normalizedRequest
            );

            if (matches.length === 0 && normalizedRequest.length >= 4) {
                matches = allMemories.filter((m) => {
                    const saved = normalize(m.content);
                    return saved.includes(normalizedRequest) || normalizedRequest.includes(saved);
                });
            }

            if (matches.length === 0) {
                return res.json({ reply: "I couldn't find a matching saved memory, Sir.", memoryDeleted: false });
            }

            if (matches.length > 1) {
                return res.json({
                    reply: "I found multiple matching memories. Please specify the exact fact to forget, Sir.",
                    memoryDeleted: false,
                    matchingMemories: matches.map((m) => ({ id: m.id, content: m.content })),
                });
            }

            const target = matches[0];
            const deleted = removeMemory(target.id);

            return res.json({
                reply: deleted
                    ? `Done, Sir. I've forgotten: ${target.content}`
                    : "I couldn't delete that memory. Please try again, Sir.",
                memoryDeleted: deleted,
                memoryId: target.id,
            });
        }

        if (isMemorySummaryRequest(cleanedMessage)) {
            const memories = listMemories();

            if (memories.length === 0) {
                return res.json({
                    reply: "I don't have any saved memories about you yet, Sir.",
                    memoriesUsed: 0,
                });
            }

            const summary = memories
                .slice(0, 20)
                .map((m) => `- ${m.content}`)
                .join("\n");

            return res.json({
                reply: `Here's what I remember about you, Sir:\n${summary}`,
                memoriesUsed: Math.min(memories.length, 20),
            });
        }

        // Build conversation.
        const history = Array.isArray(req.body?.history)
            ? req.body.history
                .filter(
                    (item) =>
                        item &&
                        ["you", "jarvis"].includes(item.role) &&
                        typeof item.text === "string"
                )
                .slice(-12)
            : [];

        const relevantMemories = getRelevantMemories(cleanedMessage);

        const memoryContext = relevantMemories.length
            ? relevantMemories.map((m) => `- [${m.category}] ${m.content}`).join("\n")
            : "No matching saved memories were found.";

        const systemPrompt =
            "You are JARVIS, a sophisticated personal AI assistant with an Iron Man-inspired personality. " +
            "You are intelligent, respectful, composed, and concise. " +
            "Address the user as 'Sir' naturally — not on every sentence, but at appropriate moments. " +
            "Use phrases like 'Yes, Sir?', 'Certainly, Sir', 'Done, Sir', 'Of course, Sir' when fitting. " +
            "Use the conversation history and saved memories to personalise your answers. " +
            "Never claim to have performed computer actions unless a tool actually did them. " +
            "Be honest when you don't know something.\n\n" +
            "Saved memories:\n" + memoryContext;

        const messages = [
            ...history.map((item) => ({
                role: item.role === "you" ? "user" : "assistant",
                content: item.text.slice(0, 4000),
            })),
            { role: "user", content: cleanedMessage },
        ];

        try {
            const reply = await callAI(systemPrompt, messages);

            return res.json({
                reply,
                provider: currentProvider,
                model: currentProvider === "gemini" ? GEMINI_MODEL : OLLAMA_MODEL,
                memoriesUsed: relevantMemories.length,
            });
        } catch (aiError) {
            console.error(`${currentProvider} request failed:`, aiError.message);

            // Automatic fallback: if Gemini fails, try Ollama.
            if (currentProvider === "gemini") {
                console.log("Gemini failed — falling back to Ollama.");

                try {
                    const fallbackReply = await callOllama(systemPrompt, messages);
                    return res.json({
                        reply: fallbackReply,
                        provider: "ollama",
                        model: OLLAMA_MODEL,
                        memoriesUsed: relevantMemories.length,
                        fallback: true,
                    });
                } catch (fallbackError) {
                    console.error("Ollama fallback also failed:", fallbackError.message);
                }
            }

            // Surface the original error.
            if (aiError.name === "AbortError") {
                return res.status(504).json({ error: "JARVIS took too long to respond. Please try again." });
            }

            if (aiError.cause?.code === "ECONNREFUSED" || aiError.cause?.code === "ECONNRESET") {
                return res.status(503).json({
                    error: "Ollama is not responding. Please check that it is running.",
                });
            }

            return res.status(502).json({ error: `AI provider error: ${aiError.message}` });
        }
    } catch (error) {
        console.error("JARVIS request failed:", error.message);
        return res.status(500).json({ error: "JARVIS couldn't process the request. Check the server logs." });
    }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, "127.0.0.1", () => {
    console.log(`JARVIS API: http://127.0.0.1:${PORT}`);
    console.log(`Provider: ${currentProvider} | Ollama: ${OLLAMA_MODEL} | Gemini: ${geminiAI ? GEMINI_MODEL : "not configured"}`);
    console.log("Memory: SQLite | Actions: registered | Agent: ready");
});
