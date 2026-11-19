import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Tiny JSON-file "database" for file records.
 * Good enough for V1; can be swapped for SQLite/Postgres later.
 *
 * Record shape:
 * { id, name, size, mime, diskPath, createdAt, expiresAt, maxDownloads, downloads }
 */
export function createStore(dbFile) {
  const records = new Map();

  try {
    const list = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    for (const r of list) records.set(r.id, r);
  } catch {
    // No DB yet (first run) - start empty.
  }

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 100);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    const tmp = `${dbFile}.tmp`;
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify([...records.values()], null, 2));
    fs.renameSync(tmp, dbFile);
  }

  return {
    get: (id) => records.get(id),
    all: () => [...records.values()],
    add(record) {
      records.set(record.id, record);
      persist();
    },
    update(id, changes) {
      const r = records.get(id);
      if (!r) return null;
      Object.assign(r, changes);
      persist();
      return r;
    },
    remove(id) {
      records.delete(id);
      persist();
    },
    saveNow,
  };
}

/** Random, URL-safe, hard-to-guess id (12 chars, 72 bits). */
export function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

export function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(id);
}

/** Why a record can no longer be downloaded, or null if it still can. */
export function unavailableReason(record, now = Date.now()) {
  if (!record) return 'not_found';
  if (now >= record.expiresAt) return 'expired';
  if (record.maxDownloads > 0 && record.downloads >= record.maxDownloads) return 'limit_reached';
  return null;
}
