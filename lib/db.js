import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'flowmap.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saved_runs (
    id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_saved_runs_user_created
    ON saved_runs (user_id, created_at DESC);
`);

export const MAX_SAVED_RUNS = 20;

export function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function createUser(email, passwordHash) {
  const result = db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)'
  ).run(email, passwordHash);
  return result.lastInsertRowid;
}

export function listRunsForUser(userId) {
  const rows = db.prepare(`
    SELECT payload FROM saved_runs
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, MAX_SAVED_RUNS);
  return rows.map(row => JSON.parse(row.payload));
}

export function upsertRun(userId, run) {
  const createdAt = run.createdAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO saved_runs (id, user_id, created_at, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      created_at = excluded.created_at,
      payload = excluded.payload
  `).run(run.id, userId, createdAt, JSON.stringify(run));
  trimRunsForUser(userId);
}

export function syncRunsForUser(userId, runs) {
  if (!Array.isArray(runs)) return listRunsForUser(userId);
  const existing = new Set(
    db.prepare('SELECT id FROM saved_runs WHERE user_id = ?').all(userId).map(r => r.id)
  );
  const insert = db.transaction((items) => {
    for (const run of items) {
      if (!run?.id || existing.has(run.id)) continue;
      const createdAt = run.createdAt || new Date().toISOString();
      db.prepare(`
        INSERT INTO saved_runs (id, user_id, created_at, payload)
        VALUES (?, ?, ?, ?)
      `).run(run.id, userId, createdAt, JSON.stringify(run));
      existing.add(run.id);
    }
  });
  insert(runs);
  trimRunsForUser(userId);
  return listRunsForUser(userId);
}

function trimRunsForUser(userId) {
  db.prepare(`
    DELETE FROM saved_runs
    WHERE user_id = ? AND id NOT IN (
      SELECT id FROM saved_runs
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `).run(userId, userId, MAX_SAVED_RUNS);
}

export function deleteRun(userId, runId) {
  const result = db.prepare(
    'DELETE FROM saved_runs WHERE user_id = ? AND id = ?'
  ).run(userId, runId);
  return result.changes > 0;
}
