import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { startServer, api, uploadBuffer, sha, randomBytes, sleep } from './helpers.js';

describe('Upload & share', () => {
  let srv;
  let a;
  before(async () => { srv = await startServer(); a = api(srv.base); });
  after(async () => { await srv.stop(); await srv.removeStorage(); });

  it('uploads a small file and downloads the exact same bytes', async () => {
    const buf = Buffer.from('hello ScanDrop\n'.repeat(100));
    const { done, file } = await uploadBuffer(srv.base, buf, { name: 'hello.txt', mime: 'text/plain' });
    assert.equal(done.status, 201);
    assert.equal(file.name, 'hello.txt');
    assert.match(file.url, /\/d\/[A-Za-z0-9_-]{12}$/);
    const dl = await a.download(file.id);
    assert.equal(dl.status, 200);
    assert.equal(sha(dl.data), sha(buf));
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="hello.txt"/);
  });

  it('uploads a 25 MB file in parallel chunks without corruption', async () => {
    const buf = randomBytes(25 * 1024 * 1024 + 4321);
    const { done, file } = await uploadBuffer(srv.base, buf, { name: 'video.mp4' }, 4);
    assert.equal(done.status, 201);
    const dl = await a.download(file.id);
    assert.equal(dl.data.length, buf.length);
    assert.equal(sha(dl.data), sha(buf));
  });

  it('keeps non-English and emoji file names', async () => {
    const name = 'रिपोर्ट 2026 📊 résumé.pdf';
    const { file } = await uploadBuffer(srv.base, Buffer.from('x'), { name });
    assert.equal(file.name, name);
    const dl = await a.download(file.id);
    assert.match(decodeURIComponent(dl.headers.get('content-disposition')), /रिपोर्ट 2026 📊 résumé\.pdf/);
  });

  it('strips folders and dangerous characters from file names', async () => {
    const { file } = await uploadBuffer(srv.base, Buffer.from('x'), { name: '../../etc/<script>alert(1)</script>.txt' });
    assert.ok(!file.name.includes('/') && !file.name.includes('<') && !file.name.includes('..'), file.name);
  });

  it('rejects empty, oversized and badly-sized uploads', async () => {
    assert.equal((await a.post('/api/uploads', { name: 'a', size: 0 })).status, 400);
    assert.equal((await a.post('/api/uploads', { name: 'a', size: -5 })).status, 400);
    assert.equal((await a.post('/api/uploads', { name: 'a', size: 'abc' })).status, 400);
    assert.equal((await a.post('/api/uploads', { name: 'a', size: 999 * 1024 ** 3 })).status, 413);
  });

  it('rejects chunks with the wrong size or index, and incomplete uploads', async () => {
    const start = await a.post('/api/uploads', { name: 'a.bin', size: 3 * 1024 * 1024 });
    const { uploadId } = start.body;
    assert.equal((await a.putChunk(uploadId, 0, Buffer.alloc(100))).status, 400);
    assert.equal((await a.putChunk(uploadId, 3, Buffer.alloc(1024 * 1024))).status, 400);
    assert.equal((await a.putChunk(uploadId, -1, Buffer.alloc(1024 * 1024))).status, 400);
    assert.equal((await a.putChunk(uploadId, 0, Buffer.alloc(1024 * 1024))).status, 200);
    const done = await a.post(`/api/uploads/${uploadId}/complete`);
    assert.equal(done.status, 409);
    assert.deepEqual(done.body.missing, [1, 2]);
  });

  it('resumes an upload: the server remembers which chunks it already has', async () => {
    const buf = randomBytes(5 * 1024 * 1024);
    const { body } = await a.post('/api/uploads', { name: 'r.bin', size: buf.length });
    for (const i of [0, 1, 3]) await a.putChunk(body.uploadId, i, buf.subarray(i * 1048576, (i + 1) * 1048576));
    const status = await a.get(`/api/uploads/${body.uploadId}`);
    assert.deepEqual(status.body.received.sort(), [0, 1, 3]);
    for (const i of [2, 4]) await a.putChunk(body.uploadId, i, buf.subarray(i * 1048576, (i + 1) * 1048576));
    const done = await a.post(`/api/uploads/${body.uploadId}/complete`);
    assert.equal(done.status, 201);
    assert.equal(sha((await a.download(done.body.id)).data), sha(buf));
  });

  it('can cancel an upload', async () => {
    const { body } = await a.post('/api/uploads', { name: 'c.bin', size: 10 });
    assert.equal((await a.del(`/api/uploads/${body.uploadId}`)).status, 204);
    assert.equal((await a.get(`/api/uploads/${body.uploadId}`)).status, 404);
  });

  it('supports resumed downloads (HTTP Range)', async () => {
    const buf = randomBytes(3 * 1024 * 1024);
    const { file } = await uploadBuffer(srv.base, buf);
    const res = await fetch(`${srv.base}/api/files/${file.id}/download`, { headers: { Range: 'bytes=1000000-' } });
    assert.equal(res.status, 206);
    const part = Buffer.from(await res.arrayBuffer());
    assert.equal(sha(part), sha(buf.subarray(1000000)));
  });

  it('serves a QR code that points at the share link', async () => {
    const { file } = await uploadBuffer(srv.base, Buffer.from('x'));
    const res = await fetch(`${srv.base}/api/files/${file.id}/qr.svg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await res.text(), /<svg/);
  });

  it('serves the download page for share links', async () => {
    const { file } = await uploadBuffer(srv.base, Buffer.from('x'));
    const res = await fetch(`${srv.base}/d/${file.id}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /ScanDrop/);
  });
});

describe('Download limits', () => {
  let srv;
  let a;
  before(async () => { srv = await startServer(); a = api(srv.base); });
  after(async () => { await srv.stop(); await srv.removeStorage(); });

  it('one-time link: works once, then is gone and deleted from disk', async () => {
    const { file } = await uploadBuffer(srv.base, Buffer.from('secret'), { maxDownloads: 1 });
    assert.equal((await a.download(file.id)).status, 200);
    const second = await a.download(file.id);
    assert.ok([404, 410].includes(second.status), `got ${second.status}`);
    await sleep(200);
    assert.deepEqual(await fs.readdir(path.join(srv.dir, 'files')), []);
  });

  it('5-download limit allows exactly 5 downloads', async () => {
    const { file } = await uploadBuffer(srv.base, Buffer.from('five'), { maxDownloads: 5 });
    for (let i = 0; i < 5; i++) assert.equal((await a.download(file.id)).status, 200, `download ${i + 1}`);
    assert.ok([404, 410].includes((await a.download(file.id)).status));
  });

  it('one-time link: two people downloading at the same moment, only one gets it', async () => {
    const buf = randomBytes(4 * 1024 * 1024);
    const { file } = await uploadBuffer(srv.base, buf, { maxDownloads: 1 });
    const results = await Promise.all([a.download(file.id), a.download(file.id)]);
    const ok = results.filter((r) => r.status === 200 && r.data.length === buf.length);
    assert.equal(ok.length, 1, `statuses: ${results.map((r) => r.status)}`);
  });

  it('one-time link: if the download is interrupted, the receiver can try again', async () => {
    const buf = randomBytes(30 * 1024 * 1024);
    const { file } = await uploadBuffer(srv.base, buf, { maxDownloads: 1 });

    // Start downloading, read a little, then lose the connection.
    const controller = new AbortController();
    const res = await fetch(`${srv.base}/api/files/${file.id}/download`, { signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await sleep(500);

    const retry = await a.download(file.id);
    assert.equal(retry.status, 200, 'the file should still be available after a failed download');
    assert.equal(sha(retry.data), sha(buf));
    assert.ok([404, 410].includes((await a.download(file.id)).status), 'gone after a complete download');
  });

  it('one-time link: an interrupted download can be resumed from where it stopped', async () => {
    const buf = randomBytes(30 * 1024 * 1024);
    const { file } = await uploadBuffer(srv.base, buf, { maxDownloads: 1 });

    const controller = new AbortController();
    const res = await fetch(`${srv.base}/api/files/${file.id}/download`, { signal: controller.signal });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    controller.abort();
    await sleep(500);

    const got = value.length;
    const rest = await fetch(`${srv.base}/api/files/${file.id}/download`, { headers: { Range: `bytes=${got}-` } });
    assert.equal(rest.status, 206);
    const whole = Buffer.concat([Buffer.from(value), Buffer.from(await rest.arrayBuffer())]);
    assert.equal(sha(whole), sha(buf));
    await sleep(200);
    assert.ok([404, 410].includes((await a.download(file.id)).status), 'counted once the last byte arrived');
  });

  it('second person gets a clear "in progress" answer while a one-time file is downloading', async () => {
    const buf = randomBytes(30 * 1024 * 1024);
    const { file } = await uploadBuffer(srv.base, buf, { maxDownloads: 1 });
    const res = await fetch(`${srv.base}/api/files/${file.id}/download`);
    const reader = res.body.getReader();
    await reader.read(); // first person is mid-download
    const second = await a.get(`/api/files/${file.id}/download`);
    assert.equal(second.status, 409);
    assert.equal(second.body.reason, 'in_progress');
    while (!(await reader.read()).done) { /* finish first download */ }
  });

  it('a failed download does not use up one of the allowed downloads', async () => {
    const buf = randomBytes(30 * 1024 * 1024);
    const { file } = await uploadBuffer(srv.base, buf, { maxDownloads: 5 });
    const controller = new AbortController();
    const res = await fetch(`${srv.base}/api/files/${file.id}/download`, { signal: controller.signal });
    await res.body.getReader().read();
    controller.abort();
    await sleep(500);
    const info = await a.get(`/api/files/${file.id}`);
    assert.equal(info.body.downloads, 0);
  });
});

describe('Owner, expiry and storage', () => {
  it('only the sender can delete a file', async () => {
    const srv = await startServer();
    const a = api(srv.base);
    try {
      const { file } = await uploadBuffer(srv.base, Buffer.from('x'));
      assert.equal((await a.del(`/api/files/${file.id}`)).status, 403);
      assert.equal((await a.del(`/api/files/${file.id}`, { 'X-Owner-Token': 'wrong' })).status, 403);
      assert.equal((await a.del(`/api/files/${file.id}`, { 'X-Owner-Token': file.ownerToken })).status, 204);
      assert.equal((await a.get(`/api/files/${file.id}`)).status, 404);
    } finally { await srv.stop(); await srv.removeStorage(); }
  });

  it('expired files are refused and deleted from disk', async () => {
    let srv = await startServer();
    const { file } = await uploadBuffer(srv.base, Buffer.from('old news'), { expiry: '10m' });
    const info = (await api(srv.base).get(`/api/files/${file.id}`)).body;
    assert.ok(Math.abs(info.expiresAt - info.createdAt - 10 * 60 * 1000) < 1000, 'expires in 10 minutes');
    await srv.stop();

    // Pretend 10 minutes passed: move the expiry into the past, then restart.
    const dbFile = path.join(srv.dir, 'files.json');
    const db = JSON.parse(await fs.readFile(dbFile, 'utf8'));
    db.find((r) => r.id === file.id).expiresAt = Date.now() - 1000;
    await fs.writeFile(dbFile, JSON.stringify(db));

    srv = await startServer({}, srv.dir);
    try {
      assert.ok([404, 410].includes((await api(srv.base).download(file.id)).status));
      await sleep(200);
      assert.deepEqual(await fs.readdir(path.join(srv.dir, 'files')), []);
    } finally { await srv.stop(); await srv.removeStorage(); }
  });

  it('files and unfinished uploads survive a server restart', async () => {
    let srv = await startServer();
    const buf = randomBytes(3 * 1024 * 1024);
    const { file } = await uploadBuffer(srv.base, Buffer.from('kept'));
    const { body } = await api(srv.base).post('/api/uploads', { name: 'half.bin', size: buf.length });
    await api(srv.base).putChunk(body.uploadId, 0, buf.subarray(0, 1048576));
    await srv.stop();

    srv = await startServer({}, srv.dir);
    const a = api(srv.base);
    try {
      assert.equal((await a.download(file.id)).data.toString(), 'kept');
      assert.deepEqual((await a.get(`/api/uploads/${body.uploadId}`)).body.received, [0]);
      for (const i of [1, 2]) await a.putChunk(body.uploadId, i, buf.subarray(i * 1048576, (i + 1) * 1048576));
      const done = await a.post(`/api/uploads/${body.uploadId}/complete`);
      assert.equal(sha((await a.download(done.body.id)).data), sha(buf));
    } finally { await srv.stop(); await srv.removeStorage(); }
  });

  it('refuses new uploads when the storage cap is reached', async () => {
    const srv = await startServer({ MAX_STORAGE_GB: String(3 / 1024) }); // 3 MB cap
    const a = api(srv.base);
    try {
      assert.equal((await uploadBuffer(srv.base, randomBytes(2 * 1024 * 1024))).done.status, 201);
      assert.equal((await a.post('/api/uploads', { name: 'x', size: 2 * 1024 * 1024 })).status, 507);
    } finally { await srv.stop(); await srv.removeStorage(); }
  });
});
