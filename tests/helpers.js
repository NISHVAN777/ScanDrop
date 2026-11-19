import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');

let nextPort = 4100 + Math.floor(Math.random() * 1500);

/**
 * Start a real ScanDrop server in a child process with its own empty storage
 * folder. Chunks are 1 MB so multi-chunk files stay small in tests.
 */
export async function startServer(env = {}, existingDir = null) {
  const dir = existingDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'scandrop-test-')));
  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      STORAGE_DIR: dir,
      CHUNK_MB: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 10_000);
    child.stdout.on('data', (d) => {
      output += d;
      if (output.includes('ScanDrop is running')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (d) => { output += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}):\n${output}`)); });
  });
  child.removeAllListeners('exit');

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    dir,
    async stop() {
      if (child.exitCode !== null) return;
      // Let the debounced metadata save finish before killing.
      await new Promise((r) => setTimeout(r, 300));
      child.kill();
      await once(child, 'exit');
    },
    async removeStorage() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

// ---------- HTTP helpers ----------

export function api(base) {
  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, headers: res.headers };
  }
  return {
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b, h) => call('POST', u, b ?? {}, h),
    del: (u, h) => call('DELETE', u, undefined, h),
    putChunk: (uid, i, buf) => fetch(`${base}/api/uploads/${uid}/chunks/${i}`, {
      method: 'PUT', body: buf, headers: { 'Content-Type': 'application/octet-stream' },
    }),
    async download(id, query = '') {
      const res = await fetch(`${base}/api/files/${id}/download${query}`);
      return { status: res.status, headers: res.headers, data: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

export const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const randomBytes = (n) => crypto.randomBytes(n);

/** Upload a whole buffer the way the browser does: start, send chunks (some in parallel), complete. */
export async function uploadBuffer(base, buf, options = {}, parallel = 3) {
  const a = api(base);
  const start = await a.post('/api/uploads', { name: 'file.bin', size: buf.length, ...options });
  if (start.status !== 201) return { start };
  const { uploadId, chunkSize, totalChunks } = start.body;
  const queue = [...Array(totalChunks).keys()];
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (queue.length) {
      const i = queue.shift();
      const res = await a.putChunk(uploadId, i, buf.subarray(i * chunkSize, (i + 1) * chunkSize));
      if (res.status !== 200) throw new Error(`chunk ${i} -> ${res.status}`);
    }
  }));
  const done = await a.post(`/api/uploads/${uploadId}/complete`);
  return { start, done, file: done.body };
}

// ---------- Server-Sent Events client (for P2P signaling) ----------

export async function sse(url) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const events = [];
  const waiters = [];
  if (res.ok) {
    (async () => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = { event: 'message', data: '' };
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) ev.event = line.slice(7);
              else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
            }
            if (block.startsWith(':')) continue;
            events.push(ev);
            waiters.splice(0).forEach((w) => w());
          }
        }
      } catch { /* aborted */ }
      events.push({ event: '__closed' });
      waiters.splice(0).forEach((w) => w());
    })();
  }
  return {
    status: res.status,
    /** Wait for the next event with this name (consumes it). */
    async next(name, timeout = 3000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const i = events.findIndex((e) => e.event === name);
        if (i >= 0) return events.splice(i, 1)[0];
        if (Date.now() > deadline) return null;
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
    },
    close: () => controller.abort(),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
