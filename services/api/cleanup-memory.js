
import { default as db } from "./src/memory.js";

const cleanup = db.transaction(() => {
    const insertIfMissing = db.prepare(`
        INSERT INTO memories (content, category)
        SELECT ?, ?
        WHERE NOT EXISTS (
            SELECT 1 FROM memories
            WHERE LOWER(TRIM(content)) = LOWER(TRIM(?))
        )
    `);

    // Preserve the useful fact from the combined records.
    insertIfMissing.run(
        "I am building a personal AI assistant called JARVIS",
        "general",
        "I am building a personal AI assistant called JARVIS"
    );

    // Delete only the three confirmed combined records.
    db.prepare(
        "DELETE FROM memories WHERE id IN (?, ?, ?)"
    ).run(4, 5, 6);
});

try {
    cleanup();

    console.log("\nMemory cleanup successful!");
    console.log(
        db.prepare(`
            SELECT id, content, category
            FROM memories
            ORDER BY id
        `).all()
    );
} finally {
    db.close();
}
