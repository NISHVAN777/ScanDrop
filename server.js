import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import busboy from 'busboy';
import QRCode from 'qrcode';

import {
  PORT, HOST, MAX_FILE_SIZE, UPLOAD_DIR, DB_FILE, PUBLIC_DIR,
  EXPIRY_OPTIONS, DEFAULT_EXPIRY, DOWNLOAD_LIMIT_OPTIONS, DEFAULT_DOWNLOAD_LIMIT,
  CLEANUP_INTERVAL_MS, getPublicBaseUrl,
} from './src/config.js';
import { createStore, newId, isValidId, unavailableReason } from './src/store.js';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const store = createStore(DB_FILE);
const activeDownloads = new Map(); // id -> number of streams in progress
const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const shareUrl = (id) => `${getPublicBaseUrl()}/d/${id}`;

function publicInfo(r) {
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    mime: r.mime,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    maxDownloads: r.maxDownloads,
    downloads: r.downloads,
    url: shareUrl(r.id),
  };
}

function deleteRecord(id) {
  const r = store.get(id);
  if (!r) return;
  store.remove(id);
  fs.rm(r.diskPath, { force: true }, () => {});
}

/** Strip path parts and control chars from a client-supplied filename. */
function cleanFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim().slice(0, 200);
  return cleaned || 'file';
}

// ---------- API ----------

app.get('/api/config', (req, res) => {
  res.json({
    maxFileSize: MAX_FILE_SIZE,
    expiryOptions: Object.keys(EXPIRY_OPTIONS),
    defaultExpiry: DEFAULT_EXPIRY,
    downloadLimitOptions: DOWNLOAD_LIMIT_OPTIONS,
    defaultDownloadLimit: DEFAULT_DOWNLOAD_LIMIT,
  });
});

/**
 * Upload a single file (multipart/form-data, field "file").
 * Optional fields: expiry ("10m" | "1h" | "24h" | "7d"), maxDownloads (1 | 5 | 10 | 0).
 * The file is streamed straight to disk, so large files don't fill up RAM.
 */
app.post('/api/upload', (req, res) => {
  const declared = Number(req.headers['content-length']);
  if (declared && declared > MAX_FILE_SIZE + 1024 * 1024) {
    return res.status(413).json({ error: `File is too large. Max is ${Math.round(MAX_FILE_SIZE / 1048576)} MB.` });
  }

  let bb;
  try {
    bb = busboy({ headers: req.headers, limits: { files: 1, fields: 10, fileSize: MAX_FILE_SIZE } });
  } catch {
    return res.status(400).json({ error: 'Expected a multipart/form-data upload.' });
  }

  const fields = {};
  let upload = null; // { id, diskPath, name, mime, size, truncated, done: Promise }
  let finished = false;

  const fail = (status, error) => {
    if (finished) return;
    finished = true;
    if (upload) fs.rm(upload.diskPath, { force: true }, () => {});
    res.status(status).json({ error });
  };

  bb.on('field', (name, value) => {
    fields[name] = value;
  });

  bb.on('file', (_field, stream, info) => {
    const id = newId();
    const diskPath = path.join(UPLOAD_DIR, id);
    const out = fs.createWriteStream(diskPath);
    upload = {
      id, diskPath,
      name: cleanFileName(info.filename),
      mime: info.mimeType || 'application/octet-stream',
      size: 0,
      truncated: false,
      done: new Promise((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
      }),
    };
    stream.on('data', (chunk) => { upload.size += chunk.length; });
    stream.on('limit', () => { upload.truncated = true; });
    stream.pipe(out);
  });

  bb.on('error', () => fail(400, 'Upload failed while reading the file.'));

  bb.on('close', async () => {
    if (finished) return;
    if (!upload) return fail(400, 'No file was sent.');
    try {
      await upload.done;
    } catch {
      return fail(500, 'Could not save the file on the server.');
    }
    if (upload.truncated) {
      return fail(413, `File is too large. Max is ${Math.round(MAX_FILE_SIZE / 1048576)} MB.`);
    }
    if (upload.size === 0) return fail(400, 'The file is empty.');

    const expiryKey = EXPIRY_OPTIONS[fields.expiry] ? fields.expiry : DEFAULT_EXPIRY;
    const limit = Number(fields.maxDownloads);
    const maxDownloads = DOWNLOAD_LIMIT_OPTIONS.includes(limit) ? limit : DEFAULT_DOWNLOAD_LIMIT;
    const now = Date.now();

    const record = {
      id: upload.id,
      name: upload.name,
      size: upload.size,
      mime: upload.mime,
      diskPath: upload.diskPath,
      createdAt: now,
      expiresAt: now + EXPIRY_OPTIONS[expiryKey],
      maxDownloads,
      downloads: 0,
    };
    store.add(record);
    finished = true;
    res.status(201).json(publicInfo(record));
  });

  // Client disconnected mid-upload: throw away the partial file.
  req.on('aborted', () => {
    finished = true;
    if (upload) fs.rm(upload.diskPath, { force: true }, () => {});
  });

  req.pipe(bb);
});

/** Look up a valid, still-available record, or send the right error. */
function findAvailable(req, res) {
  const { id } = req.params;
  const record = isValidId(id) ? store.get(id) : undefined;
  const reason = unavailableReason(record);
  if (reason) {
    const messages = {
      not_found: 'This file does not exist or was already deleted.',
      expired: 'This link has expired.',
      limit_reached: 'This file reached its download limit.',
    };
    res.status(reason === 'not_found' ? 404 : 410).json({ error: messages[reason], reason });
    return null;
  }
  return record;
}

app.get('/api/files/:id', (req, res) => {
  const record = findAvailable(req, res);
  if (record) res.json(publicInfo(record));
});

app.get('/api/files/:id/qr.svg', async (req, res) => {
  const record = findAvailable(req, res);
  if (!record) return;
  const svg = await QRCode.toString(shareUrl(record.id), {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M',
  });
  res.type('image/svg+xml').setHeader('Cache-Control', 'no-store');
  res.send(svg);
});

app.get('/api/files/:id/download', (req, res) => {
  const record = findAvailable(req, res);
  if (!record) return;

  // Resumed downloads send a Range header (e.g. "bytes=5000-"). Only count
  // the request that starts from the beginning as a new download.
  const range = req.headers.range;
  const isFreshDownload = !range || /^bytes=0-/.test(range);
  if (isFreshDownload) store.update(record.id, { downloads: record.downloads + 1 });

  activeDownloads.set(record.id, (activeDownloads.get(record.id) || 0) + 1);
  res.download(record.diskPath, record.name, { dotfiles: 'allow' }, (err) => {
    const left = (activeDownloads.get(record.id) || 1) - 1;
    if (left > 0) activeDownloads.set(record.id, left);
    else activeDownloads.delete(record.id);

    if (err && !res.headersSent) res.status(500).json({ error: 'Download failed.' });
    // Single-use / limit reached: delete as soon as the last transfer finishes.
    if (left <= 0 && unavailableReason(store.get(record.id))) deleteRecord(record.id);
  });
});

// Sender can delete their file early.
app.delete('/api/files/:id', (req, res) => {
  const { id } = req.params;
  if (!isValidId(id) || !store.get(id)) return res.status(404).json({ error: 'Not found.' });
  deleteRecord(id);
  res.status(204).end();
});

// ---------- Pages ----------

app.get('/d/:id', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'download.html'));
});

app.use(express.static(PUBLIC_DIR));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'download.html'));
});

// ---------- Cleanup ----------

function cleanup() {
  for (const r of store.all()) {
    if (unavailableReason(r) && !activeDownloads.has(r.id)) deleteRecord(r.id);
  }
  // Remove leftover partial uploads that have no record (e.g. after a crash).
  const known = new Set(store.all().map((r) => path.basename(r.diskPath)));
  for (const file of fs.readdirSync(UPLOAD_DIR)) {
    if (known.has(file)) continue;
    const full = path.join(UPLOAD_DIR, file);
    try {
      const age = Date.now() - fs.statSync(full).mtimeMs;
      if (age > 60 * 60 * 1000) fs.rmSync(full, { force: true });
    } catch { /* ignore */ }
  }
}
cleanup();
setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  ScanDrop is running`);
  console.log(`  On this computer:   http://localhost:${PORT}`);
  console.log(`  QR links point to:  ${getPublicBaseUrl()}  (phones must be on the same Wi-Fi)\n`);
});
// Allow long uploads/downloads of big files on slow connections.
server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.saveNow();
    process.exit(0);
  });
}
