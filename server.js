import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import {
  PORT, HOST, MAX_FILE_SIZE, CHUNK_SIZE, UPLOAD_DIR, PARTIAL_DIR, DB_FILE, UPLOADS_DB_FILE,
  SECRET_FILE, PUBLIC_DIR, EXPIRY_OPTIONS, DEFAULT_EXPIRY, DOWNLOAD_LIMIT_OPTIONS,
  DEFAULT_DOWNLOAD_LIMIT, CLEANUP_INTERVAL_MS, PENDING_UPLOAD_TTL, ACCESS_TOKEN_TTL,
  TRUST_PROXY, getPublicBaseUrl,
} from './src/config.js';
import { createStore, unavailableReason } from './src/store.js';
import { loadOrCreateSecret, createAccessTokens, rateLimit } from './src/security.js';
import { uploadRoutes } from './src/routes/uploads.js';
import { fileRoutes } from './src/routes/files.js';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PARTIAL_DIR, { recursive: true });

const files = createStore(DB_FILE);        // finished, shareable files
const uploads = createStore(UPLOADS_DB_FILE); // uploads still in progress
const tokens = createAccessTokens(loadOrCreateSecret(SECRET_FILE), ACCESS_TOKEN_TTL);
const activeDownloads = new Map(); // file id -> number of streams in progress

const shareUrl = (id) => `${getPublicBaseUrl()}/d/${id}`;

/** What the API reveals about a file. Never includes disk paths or secrets. */
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
    protected: Boolean(r.pinHash),
    url: shareUrl(r.id),
  };
}

function deleteFile(id) {
  const r = files.get(id);
  if (!r) return;
  files.remove(id);
  fs.rm(r.diskPath, { force: true }, () => {});
}

const limits = {
  api: rateLimit({ windowMs: 60_000, max: 300 }),
  createUpload: rateLimit({ windowMs: 10 * 60_000, max: 30, message: 'Too many uploads. Please wait a few minutes.' }),
  chunk: rateLimit({ windowMs: 10 * 60_000, max: 3000 }),
  unlock: rateLimit({ windowMs: 10 * 60_000, max: 20, message: 'Too many PIN attempts. Please wait a few minutes.' }),
};

const app = express();
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ---------- API ----------

app.get('/api/config', (req, res) => {
  res.json({
    maxFileSize: MAX_FILE_SIZE,
    chunkSize: CHUNK_SIZE,
    expiryOptions: Object.keys(EXPIRY_OPTIONS),
    defaultExpiry: DEFAULT_EXPIRY,
    downloadLimitOptions: DOWNLOAD_LIMIT_OPTIONS,
    defaultDownloadLimit: DEFAULT_DOWNLOAD_LIMIT,
  });
});

app.use('/api/uploads', uploadRoutes({ files, uploads, limits, publicInfo }));
app.use('/api/files', limits.api,
  fileRoutes({ files, limits, tokens, publicInfo, shareUrl, deleteFile, activeDownloads }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------- Pages ----------

app.get('/d/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'download.html')));
app.use(express.static(PUBLIC_DIR));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'download.html')));

// ---------- Cleanup ----------

function removeOrphans(dir, known) {
  for (const name of fs.readdirSync(dir)) {
    if (known.has(name)) continue;
    const full = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > 60 * 60 * 1000) fs.rmSync(full, { force: true });
    } catch { /* ignore */ }
  }
}

function cleanup() {
  const now = Date.now();
  for (const r of files.all()) {
    if (unavailableReason(r, now) && !activeDownloads.has(r.id)) deleteFile(r.id);
  }
  for (const u of uploads.all()) {
    if (now - u.updatedAt > PENDING_UPLOAD_TTL) {
      uploads.remove(u.id);
      fs.rm(u.diskPath, { force: true }, () => {});
    }
  }
  removeOrphans(UPLOAD_DIR, new Set(files.all().map((r) => path.basename(r.diskPath))));
  removeOrphans(PARTIAL_DIR, new Set(uploads.all().map((u) => path.basename(u.diskPath))));
}
cleanup();
setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

// ---------- Start ----------

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  ScanDrop is running`);
  console.log(`  On this computer:   http://localhost:${PORT}`);
  console.log(`  QR links point to:  ${getPublicBaseUrl()}  (phones must be on the same Wi-Fi)\n`);
});
// Big downloads on slow connections can take a long time.
server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    files.saveNow();
    uploads.saveNow();
    process.exit(0);
  });
}
