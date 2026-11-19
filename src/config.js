import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');

export const PORT = Number(process.env.PORT) || 3000;
export const HOST = process.env.HOST || '0.0.0.0';

// Max upload size in MB (default 2 GB).
export const MAX_FILE_SIZE = (Number(process.env.MAX_FILE_MB) || 2048) * 1024 * 1024;

// Total space all files (finished + in-progress) may use, in GB (default 20 GB).
export const MAX_TOTAL_STORAGE = (Number(process.env.MAX_STORAGE_GB) || 20) * 1024 * 1024 * 1024;

// Files are uploaded in pieces of this size (default 8 MB).
export const CHUNK_SIZE = (Number(process.env.CHUNK_MB) || 8) * 1024 * 1024;
// An unfinished upload is thrown away after this long without new chunks.
export const PENDING_UPLOAD_TTL = 24 * 60 * 60 * 1000;

export const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(ROOT, 'storage'));
export const UPLOAD_DIR = path.join(STORAGE_DIR, 'files');
export const PARTIAL_DIR = path.join(STORAGE_DIR, 'partial');
export const DB_FILE = path.join(STORAGE_DIR, 'files.json');
export const UPLOADS_DB_FILE = path.join(STORAGE_DIR, 'uploads.json');
export const SECRET_FILE = path.join(STORAGE_DIR, 'secret.key');
export const PUBLIC_DIR = path.join(ROOT, 'public');

// PIN protection
export const PIN_MAX_ATTEMPTS = 5;               // wrong tries before a lock
export const PIN_LOCK_MS = 10 * 60 * 1000;       // lock length after too many wrong tries
export const ACCESS_TOKEN_TTL = 60 * 60 * 1000;  // how long an unlocked link stays unlocked

// Set TRUST_PROXY=1 when running behind a reverse proxy (Nginx, Render, etc.)
// so rate limits see the real client IP.
export const TRUST_PROXY = process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || 1 : false;

// How long a file can live, chosen by the sender.
export const EXPIRY_OPTIONS = {
  '10m': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};
export const DEFAULT_EXPIRY = '24h';

// 0 = unlimited downloads (until expiry).
export const DOWNLOAD_LIMIT_OPTIONS = [1, 5, 10, 0];
export const DEFAULT_DOWNLOAD_LIMIT = 0;

export const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * The address put inside the QR code. "localhost" would not work from a phone,
 * so by default we use this computer's Wi-Fi/LAN IP. Set PUBLIC_URL when deployed.
 */
export function getPublicBaseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return `http://${getLanIp()}:${PORT}`;
}

function getLanIp() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  // Prefer typical home/office ranges and skip virtual adapters where possible.
  const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|vbox/i;
  const preferred =
    candidates.find((c) => !virtual.test(c.name) && /^192\.168\./.test(c.address)) ||
    candidates.find((c) => !virtual.test(c.name) && /^(10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address)) ||
    candidates.find((c) => !virtual.test(c.name)) ||
    candidates[0];
  return preferred ? preferred.address : 'localhost';
}
