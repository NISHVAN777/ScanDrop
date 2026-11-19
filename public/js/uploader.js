/**
 * Resumable chunked uploader.
 *
 * - Splits the file into chunks (size decided by the server) and sends a few at a time.
 * - Retries failed chunks with backoff.
 * - pause() / resume() at any time.
 * - Remembers the upload in localStorage, so picking the same file again after a
 *   refresh or crash continues where it stopped instead of starting over.
 */

import { FileKey, encryptedLayout } from './e2e.js';

const PARALLEL = 3;
const MAX_RETRIES = 5;
const RESUME_PREFIX = 'scandrop:resume:';

const resumeKey = (f) => `${RESUME_PREFIX}${f.name}:${f.size}:${f.lastModified}`;

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}
function storageDel(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export class UploadError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new UploadError('Network error. Check your connection.', { retryable: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new UploadError(data.error || `Request failed (${res.status}).`, { retryable: res.status >= 500 || res.status === 429 }),
      { status: res.status, data },
    );
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ChunkedUpload {
  /**
   * @param {File} file
   * @param {{expiry: string, maxDownloads: number, pin?: string, encrypt?: boolean}} options
   * @param {{onProgress?: Function, onState?: Function}} hooks
   */
  constructor(file, options, hooks = {}) {
    this.file = file;
    this.options = options;
    this.hooks = hooks;
    this.key = resumeKey(file);
    this.status = null;     // server's view: uploadId, chunkSize, totalChunks
    this.done = new Set();  // chunk indexes the server has confirmed
    this.inflight = new Map(); // index -> { xhr, loaded }
    this.state = 'idle';    // idle | uploading | paused | completing | done | cancelled | error
    this.resumedFrom = 0;   // bytes already on the server when we started
    this.samples = [];      // [time, bytes] for speed calculation
    this.fileKey = null;    // FileKey when end-to-end encrypted
    this.plainChunk = 0;    // plaintext bytes per piece when encrypted
    this.serverSize = file.size; // bytes the server stores (ciphertext is a bit bigger)
  }

  setState(state, detail) {
    this.state = state;
    this.hooks.onState?.(state, detail);
  }

  get uploadedBytes() {
    let bytes = 0;
    for (const i of this.done) bytes += this.chunkLength(i);
    for (const { loaded } of this.inflight.values()) bytes += loaded;
    return bytes;
  }

  chunkLength(i) {
    const { chunkSize } = this.status;
    return Math.min(chunkSize, this.serverSize - i * chunkSize);
  }

  /** Start (or continue a previously interrupted) upload. Resolves with file info when finished. */
  async start() {
    const encrypt = Boolean(this.options.encrypt);
    if (encrypt) this.key += ':e2e';
    const saved = storageGet(this.key);
    if (saved?.uploadId) {
      try {
        this.status = await api('GET', `/api/uploads/${saved.uploadId}`);
        if (encrypt) this.fileKey = FileKey.fromString(saved.fileKey);
      } catch {
        storageDel(this.key); // expired or gone - start fresh
        this.status = null;
      }
    }
    if (encrypt) {
      const { chunkSize } = this.status || (await api('GET', '/api/config'));
      const layout = encryptedLayout(this.file.size, chunkSize);
      this.plainChunk = layout.plainChunk;
      this.serverSize = layout.encryptedSize;
    }
    if (!this.status) {
      const body = {
        expiry: this.options.expiry,
        maxDownloads: this.options.maxDownloads,
        pin: this.options.pin || undefined,
      };
      if (encrypt) {
        this.fileKey = FileKey.generate();
        Object.assign(body, {
          encrypted: true,
          size: this.serverSize,
          meta: await this.fileKey.encryptMeta({ name: this.file.name, mime: this.file.type, size: this.file.size }),
        });
      } else {
        Object.assign(body, { name: this.file.name, size: this.file.size, mime: this.file.type });
      }
      this.status = await api('POST', '/api/uploads', body);
      // The key is kept locally only until the upload finishes, so it can resume.
      storageSet(this.key, { uploadId: this.status.uploadId, fileKey: this.fileKey?.toString() });
    }
    this.done = new Set(this.status.received);
    this.resumedFrom = this.uploadedBytes;
    return this.run();
  }

  async run() {
    this.setState('uploading', { resumed: this.resumedFrom > 0 });
    this.samples = [[performance.now(), this.uploadedBytes]];
    const ticker = setInterval(() => this.reportProgress(), 250);

    try {
      const queue = [];
      for (let i = 0; i < this.status.totalChunks; i++) if (!this.done.has(i)) queue.push(i);

      const worker = async () => {
        while (queue.length && this.state === 'uploading') {
          const index = queue.shift();
          try {
            await this.sendWithRetry(index);
          } catch (err) {
            if (this.state === 'uploading') {
              queue.unshift(index);
              throw err;
            }
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    } catch (err) {
      clearInterval(ticker);
      this.abortInflight();
      if (err.retryable) {
        // Connection trouble: pause so the user can resume when it's back.
        this.setState('paused', { reason: err.message });
        return null;
      }
      this.setState('error', { message: err.message });
      if (err.status === 404) storageDel(this.key);
      throw err;
    }
    clearInterval(ticker);

    if (this.state !== 'uploading') return null; // paused or cancelled meanwhile
    this.reportProgress();

    this.setState('completing');
    const info = await api('POST', `/api/uploads/${this.status.uploadId}/complete`);
    storageDel(this.key);
    if (this.fileKey) {
      info.fileKey = this.fileKey.toString();
      info.url = `${info.url}#${info.fileKey}`; // key stays in the fragment, never sent to the server
      info.name = this.file.name;
      info.size = this.file.size;
    }
    this.setState('done', info);
    return info;
  }

  async sendWithRetry(index) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendChunk(index);
      } catch (err) {
        if (this.state !== 'uploading') throw err;
        if (!err.retryable || attempt >= MAX_RETRIES) throw err;
        await sleep(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
  }

  /** The bytes to send for piece `index`: a slice of the file, encrypted if enabled. */
  async chunkBody(index) {
    if (!this.fileKey) {
      const start = index * this.status.chunkSize;
      return this.file.slice(start, start + this.chunkLength(index));
    }
    const start = index * this.plainChunk;
    const plain = await this.file.slice(start, start + this.plainChunk).arrayBuffer();
    return this.fileKey.encryptChunk(index, plain);
  }

  async sendChunk(index) {
    const body = await this.chunkBody(index);
    if (this.state !== 'uploading') throw new UploadError('Paused.', { retryable: true });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const entry = { xhr, loaded: 0 };
      this.inflight.set(index, entry);

      xhr.upload.onprogress = (e) => { entry.loaded = e.loaded; };
      xhr.onload = () => {
        this.inflight.delete(index);
        if (xhr.status >= 200 && xhr.status < 300) {
          this.done.add(index);
          resolve();
        } else {
          let msg = `Upload failed (${xhr.status}).`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignore */ }
          const retryable = xhr.status >= 500 || xhr.status === 429 || xhr.status === 400;
          reject(Object.assign(new UploadError(msg, { retryable }), { status: xhr.status }));
        }
      };
      xhr.onerror = () => {
        this.inflight.delete(index);
        reject(new UploadError('Connection lost.', { retryable: true }));
      };
      xhr.onabort = () => {
        this.inflight.delete(index);
        reject(new UploadError('Paused.', { retryable: true }));
      };

      xhr.open('PUT', `/api/uploads/${this.status.uploadId}/chunks/${index}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(body);
    });
  }

  reportProgress() {
    const now = performance.now();
    const bytes = this.uploadedBytes;
    this.samples.push([now, bytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 5000) this.samples.shift();
    const [t0, b0] = this.samples[0];
    const speed = now > t0 ? ((bytes - b0) / (now - t0)) * 1000 : 0;
    this.hooks.onProgress?.({
      loaded: bytes,
      total: this.serverSize,
      speed,
      eta: speed > 0 ? (this.serverSize - bytes) / speed : Infinity,
      chunksDone: this.done.size,
      totalChunks: this.status.totalChunks,
    });
  }

  abortInflight() {
    for (const { xhr } of this.inflight.values()) xhr.abort();
    this.inflight.clear();
  }

  pause() {
    if (this.state !== 'uploading') return;
    this.setState('paused', { reason: null });
    this.abortInflight();
  }

  resume() {
    if (this.state !== 'paused') return null;
    return this.run();
  }

  async cancel() {
    const was = this.state;
    this.setState('cancelled');
    this.abortInflight();
    storageDel(this.key);
    if (this.status && was !== 'done') {
      await fetch(`/api/uploads/${this.status.uploadId}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}
