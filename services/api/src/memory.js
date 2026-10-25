
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

// Keep the existing database location so saved memories are preserved.
const dataDirectory = path.resolve(currentDirectory, "../data");
fs.mkdirSync(dataDirectory, { recursive: true });

const databasePath = path.join(dataDirectory, "jarvis-memory.db");
const db = new Database(databasePath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
`);

// Prepared statements
const insertMemory = db.prepare(`
    INSERT INTO memories (content, category)
    VALUES (?, ?)
`);

const findExactMemory = db.prepare(`
    SELECT id, content, category, created_at
    FROM memories
    WHERE LOWER(TRIM(content)) = LOWER(TRIM(?))
    ORDER BY updated_at DESC
    LIMIT 1
`);

const updateMemoryStatement = db.prepare(`
    UPDATE memories
    SET content = ?, category = ?, updated_at = datetime('now')
    WHERE id = ?
`);

const findMemories = db.prepare(`
    SELECT id, content, category, created_at
    FROM memories
    WHERE content LIKE ? COLLATE NOCASE
    ORDER BY updated_at DESC
    LIMIT 10
`);

const getAllMemories = db.prepare(`
    SELECT id, content, category, created_at
    FROM memories
    ORDER BY updated_at DESC
`);

const getMemoryById = db.prepare(`
    SELECT id, content, category, created_at
    FROM memories
    WHERE id = ?
`);

const deleteMemory = db.prepare(`
    DELETE FROM memories
    WHERE id = ?
`);

/**
 * Save a memory.
 * If the exact same content already exists, update that record
 * instead of inserting a duplicate.
 *
 * Returns the memory ID, preserving the previous API.
 */
export function saveMemory(content, category = "general") {
    if (typeof content !== "string") {
        throw new Error("Memory content must be a string.");
    }

    const cleanedContent = content.trim();
    const cleanedCategory =
        typeof category === "string" && category.trim()
            ? category.trim()
            : "general";

    if (!cleanedContent || cleanedContent.length > 1000) {
        throw new Error("Memory must contain 1–1000 characters.");
    }

    if (cleanedCategory.length > 100) {
        throw new Error("Memory category must not exceed 100 characters.");
    }

    const existingMemory = findExactMemory.get(cleanedContent);

    if (existingMemory) {
        updateMemoryStatement.run(
            cleanedContent,
            cleanedCategory,
            existingMemory.id
        );

        return existingMemory.id;
    }

    const result = insertMemory.run(cleanedContent, cleanedCategory);
    return Number(result.lastInsertRowid);
}

/**
 * Search memories by text.
 * An empty query returns all saved memories.
 */
export function searchMemories(query) {
    if (typeof query !== "string") {
        throw new Error("Search query must be a string.");
    }

    const cleanedQuery = query.trim();

    if (!cleanedQuery) {
        return listMemories();
    }

    return findMemories.all(`%${cleanedQuery}%`);
}

/**
 * Return every saved memory.
 */
export function listMemories() {
    return getAllMemories.all();
}

/**
 * Retrieve one memory by its numeric ID.
 */
export function getMemoryByIdByJarvis(id) {
    const numericId = Number(id);

    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        return null;
    }

    return getMemoryById.get(numericId) ?? null;
}

/**
 * Delete one memory by its numeric ID.
 */
export function removeMemory(id) {
    const numericId = Number(id);

    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        return false;
    }

    return deleteMemory.run(numericId).changes > 0;
}

export default db;
