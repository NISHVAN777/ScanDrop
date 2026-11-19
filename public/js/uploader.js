/**
 * Resumable chunked uploader.
 *
 * - Splits the file into chunks (size decided by the server) and sends a few at a time.
 * - Retries failed chunks with backoff.
 * - pause() / resume() at any time.
 * - Remembers the upload in localStorage, so picking the same file again after a
 *   refresh or crash continues where it stopped instead of starting over.
 */

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
   * @param {{expiry: string, maxDownloads: number, pin?: string}} options
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
    return Math.min(chunkSize, this.file.size - i * chunkSize);
  }

  /** Start (or continue a previously interrupted) upload. Resolves with file info when finished. */
  async start() {
    const saved = storageGet(this.key);
    if (saved?.uploadId) {
      try {
        this.status = await api('GET', `/api/uploads/${saved.uploadId}`);
      } catch {
        storageDel(this.key); // expired or gone - start fresh
      }
    }
    if (!this.status) {
      this.status = await api('POST', '/api/uploads', {
        name: this.file.name,
        size: this.file.size,
        mime: this.file.type,
        expiry: this.options.expiry,
        maxDownloads: this.options.maxDownloads,
        pin: this.options.pin || undefined,
      });
      storageSet(this.key, { uploadId: this.status.uploadId });
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

  sendChunk(index) {
    return new Promise((resolve, reject) => {
      const start = index * this.status.chunkSize;
      const blob = this.file.slice(start, start + this.chunkLength(index));
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
      xhr.send(blob);
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
      total: this.file.size,
      speed,
      eta: speed > 0 ? (this.file.size - bytes) / speed : Infinity,
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
