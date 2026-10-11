
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "data");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(
    path.join(dataDir, "memory.db")
);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_session
  ON conversations(session_id, id);
`);

const insertMessage = db.prepare(`
  INSERT INTO conversations
    (session_id, role, content)
  VALUES (?, ?, ?)
`);

const getMessages = db.prepare(`
  SELECT role, content
  FROM conversations
  WHERE session_id = ?
  ORDER BY id DESC
  LIMIT ?
`);

export function saveMessage(sessionId, role, content) {
    insertMessage.run(sessionId, role, content);
}

export function getRecentMessages(
    sessionId,
    limit = 10
) {
    return getMessages
        .all(sessionId, limit)
        .reverse();
}

export function clearSession(sessionId) {
    db.prepare(`
    DELETE FROM conversations
    WHERE session_id = ?
  `).run(sessionId);
}
