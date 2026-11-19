import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express from 'express';

import {
  MAX_FILE_SIZE, MAX_TOTAL_STORAGE, CHUNK_SIZE, PARTIAL_DIR, UPLOAD_DIR,
  EXPIRY_OPTIONS, DEFAULT_EXPIRY, DOWNLOAD_LIMIT_OPTIONS, DEFAULT_DOWNLOAD_LIMIT,
} from '../config.js';
import { newId, isValidId } from '../store.js';
import { isValidPin, hashPin, newOwnerToken, hashToken } from '../security.js';
import { cleanFileName, cleanMime, mb } from '../util.js';

/**
 * Chunked, resumable uploads.
 *
 *   POST   /api/uploads                     start: { name, size, mime, expiry, maxDownloads, pin? }
 *   GET    /api/uploads/:uid                which chunks the server already has (for resuming)
 *   PUT    /api/uploads/:uid/chunks/:index  raw bytes of one chunk
 *   POST   /api/uploads/:uid/complete       all chunks sent -> becomes a shareable file
 *   DELETE /api/uploads/:uid                cancel and throw away
 *
 * The upload id is separate from the final file id, so knowing a share link
 * never lets anyone write to the file.
 */
export function uploadRoutes({ files, uploads, limits, publicInfo }) {
  const r = express.Router();

  const status = (u) => ({
    uploadId: u.id,
    name: u.name,
    size: u.size,
    chunkSize: u.chunkSize,
    totalChunks: u.totalChunks,
    received: u.received,
  });

  const usedBytes = () =>
    files.all().reduce((s, f) => s + f.size, 0) + uploads.all().reduce((s, u) => s + u.size, 0);

  function getUpload(req, res) {
    const { uid } = req.params;
    const u = isValidId(uid) ? uploads.get(uid) : undefined;
    if (!u) {
      res.status(404).json({ error: 'This upload was not found or has expired. Please start again.' });
      return null;
    }
    return u;
  }

  r.post('/', limits.createUpload, express.json({ limit: '4kb' }), (req, res) => {
    const { name, size, mime, expiry, maxDownloads, pin } = req.body || {};
    const bytes = Number(size);

    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      return res.status(400).json({ error: 'Invalid or empty file.' });
    }
    if (bytes > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `File is too large. Max is ${mb(MAX_FILE_SIZE)}.` });
    }
    const hasPin = pin !== undefined && pin !== null && pin !== '';
    if (hasPin && !isValidPin(String(pin))) {
      return res.status(400).json({ error: 'PIN must be 4 to 8 digits.' });
    }
    if (usedBytes() + bytes > MAX_TOTAL_STORAGE) {
      return res.status(507).json({ error: 'The server is out of space right now. Please try again later.' });
    }

    const limit = Number(maxDownloads);
    const id = newId();
    const diskPath = path.join(PARTIAL_DIR, id);
    fs.writeFileSync(diskPath, ''); // chunks are written into this at their offsets

    const now = Date.now();
    const upload = {
      id,
      name: cleanFileName(name),
      size: bytes,
      mime: cleanMime(mime),
      expiryKey: EXPIRY_OPTIONS[expiry] ? expiry : DEFAULT_EXPIRY,
      maxDownloads: DOWNLOAD_LIMIT_OPTIONS.includes(limit) ? limit : DEFAULT_DOWNLOAD_LIMIT,
      pinHash: hasPin ? hashPin(String(pin)) : null,
      chunkSize: CHUNK_SIZE,
      totalChunks: Math.ceil(bytes / CHUNK_SIZE),
      received: [],
      diskPath,
      createdAt: now,
      updatedAt: now,
    };
    uploads.add(upload);
    res.status(201).json(status(upload));
  });

  r.get('/:uid', (req, res) => {
    const u = getUpload(req, res);
    if (u) res.json(status(u));
  });

  r.put('/:uid/chunks/:index', limits.chunk, async (req, res) => {
    const u = getUpload(req, res);
    if (!u) return;

    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= u.totalChunks) {
      return res.status(400).json({ error: 'Invalid chunk number.' });
    }
    const start = index * u.chunkSize;
    const expected = Math.min(u.chunkSize, u.size - start);
    if (Number(req.headers['content-length']) !== expected) {
      return res.status(400).json({ error: `Chunk ${index} must be exactly ${expected} bytes.` });
    }

    let written = 0;
    req.on('data', (c) => { written += c.length; });
    try {
      await pipeline(req, fs.createWriteStream(u.diskPath, { flags: 'r+', start }));
    } catch {
      // Client disconnected mid-chunk; it will retry this chunk.
      if (!res.headersSent) res.status(400).json({ error: 'Chunk was interrupted.' });
      return;
    }
    if (written !== expected) {
      return res.status(400).json({ error: 'Chunk was incomplete.' });
    }

    // The upload could have been cancelled while this chunk was in flight.
    const current = uploads.get(u.id);
    if (!current) return res.status(404).json({ error: 'Upload was cancelled.' });
    if (!current.received.includes(index)) current.received.push(index);
    uploads.update(u.id, { received: current.received, updatedAt: Date.now() });
    res.json({ index, receivedCount: current.received.length, totalChunks: current.totalChunks });
  });

  r.post('/:uid/complete', (req, res) => {
    const u = getUpload(req, res);
    if (!u) return;

    if (u.received.length !== u.totalChunks) {
      const have = new Set(u.received);
      const missing = [];
      for (let i = 0; i < u.totalChunks && missing.length < 50; i++) if (!have.has(i)) missing.push(i);
      return res.status(409).json({ error: 'Some parts of the file are missing.', missing });
    }
    let actualSize;
    try {
      actualSize = fs.statSync(u.diskPath).size;
    } catch {
      uploads.remove(u.id);
      return res.status(500).json({ error: 'The uploaded data was lost. Please start again.' });
    }
    if (actualSize !== u.size) {
      return res.status(409).json({ error: 'File size does not match. Please start again.' });
    }

    const fileId = newId();
    const finalPath = path.join(UPLOAD_DIR, fileId);
    fs.renameSync(u.diskPath, finalPath);
    uploads.remove(u.id);

    const ownerToken = newOwnerToken();
    const now = Date.now();
    const record = {
      id: fileId,
      name: u.name,
      size: u.size,
      mime: u.mime,
      diskPath: finalPath,
      createdAt: now,
      expiresAt: now + EXPIRY_OPTIONS[u.expiryKey],
      maxDownloads: u.maxDownloads,
      downloads: 0,
      pinHash: u.pinHash,
      failedPinAttempts: 0,
      lockedUntil: 0,
      ownerTokenHash: hashToken(ownerToken),
    };
    files.add(record);
    res.status(201).json({ ...publicInfo(record), ownerToken });
  });

  r.delete('/:uid', (req, res) => {
    const u = getUpload(req, res);
    if (!u) return;
    uploads.remove(u.id);
    fs.rm(u.diskPath, { force: true }, () => {});
    res.status(204).end();
  });

  return r;
}
