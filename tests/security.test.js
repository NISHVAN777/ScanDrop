import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, api, uploadBuffer, sha, randomBytes } from './helpers.js';
import { FileKey, encryptedLayout } from '../public/js/e2e.js';
import { gcm } from '@noble/ciphers/aes.js';

describe('PIN-protected links', () => {
  let srv;
  let a;
  before(async () => { srv = await startServer(); a = api(srv.base); });
  after(async () => { await srv.stop(); await srv.removeStorage(); });

  it('hides the file until the right PIN is entered', async () => {
    const buf = Buffer.from('payroll');
    const { file } = await uploadBuffer(srv.base, buf, { name: 'payroll.xlsx', pin: '4821' });
    const info = await a.get(`/api/files/${file.id}`);
    assert.equal(info.body.protected, true);
    assert.equal(info.body.name, undefined, 'name must be hidden');
    assert.equal(info.body.size, undefined, 'size must be hidden');
    assert.equal((await a.download(file.id)).status, 401);

    const wrong = await a.post(`/api/files/${file.id}/unlock`, { pin: '0000' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.attemptsLeft, 4);

    const right = await a.post(`/api/files/${file.id}/unlock`, { pin: '4821' });
    assert.equal(right.status, 200);
    assert.equal(right.body.name, 'payroll.xlsx');
    const dl = await a.download(file.id, `?t=${encodeURIComponent(right.body.token)}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.data.toString(), 'payroll');
  });

  it('locks the file after 5 wrong PINs, even for the right PIN', async () => {
    const { file } = await uploadBuffer(srv.base, Buffer.from('x'), { pin: '123456' });
    let r;
    for (let i = 0; i < 5; i++) r = await a.post(`/api/files/${file.id}/unlock`, { pin: '999999' });
    assert.equal(r.status, 429);
    assert.equal((await a.post(`/api/files/${file.id}/unlock`, { pin: '123456' })).status, 429);
  });

  it("a token for one file doesn't open another, and tampered tokens fail", async () => {
    const one = (await uploadBuffer(srv.base, Buffer.from('1'), { pin: '1111' })).file;
    const two = (await uploadBuffer(srv.base, Buffer.from('2'), { pin: '2222' })).file;
    const { token } = (await a.post(`/api/files/${one.id}/unlock`, { pin: '1111' })).body;
    assert.equal((await a.download(two.id, `?t=${encodeURIComponent(token)}`)).status, 401);
    const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
    assert.equal((await a.download(one.id, `?t=${encodeURIComponent(tampered)}`)).status, 401);
    const forever = `9999999999999.${token.split('.')[1]}`; // longer expiry, old signature
    assert.equal((await a.download(one.id, `?t=${encodeURIComponent(forever)}`)).status, 401);
  });

  it('rejects PINs that are not 4-8 digits', async () => {
    for (const pin of ['12', '123456789', 'abcd', '12 34']) {
      assert.equal((await a.post('/api/uploads', { name: 'x', size: 1, pin })).status, 400, pin);
    }
  });
});

describe('End-to-end encryption', () => {
  let srv;
  let a;
  before(async () => { srv = await startServer(); a = api(srv.base); });
  after(async () => { await srv.stop(); await srv.removeStorage(); });

  /** Encrypt and upload exactly like the browser uploader does. */
  async function uploadEncrypted(plain, meta, extra = {}) {
    const { chunkSize } = (await a.get('/api/config')).body;
    const key = FileKey.generate();
    const layout = encryptedLayout(plain.length, chunkSize);
    const enc = [];
    for (let i = 0; i < layout.chunks; i++) {
      enc.push(Buffer.from(await key.encryptChunk(i, plain.subarray(i * layout.plainChunk, (i + 1) * layout.plainChunk))));
    }
    const cipher = Buffer.concat(enc);
    assert.equal(cipher.length, layout.encryptedSize);
    const { file } = await uploadBuffer(srv.base, cipher, {
      encrypted: true, size: cipher.length, meta: await key.encryptMeta(meta), name: undefined, ...extra,
    });
    return { key, file, cipher, chunkSize };
  }

  async function decryptAll(key, data, chunkSize) {
    const out = [];
    for (let i = 0, off = 0; off < data.length; i++, off += chunkSize) {
      out.push(Buffer.from(await key.decryptChunk(i, data.subarray(off, off + chunkSize))));
    }
    return Buffer.concat(out);
  }

  it('the server only ever sees ciphertext and a dummy name', async () => {
    const plain = Buffer.from('TOP-SECRET-MARKER\n'.repeat(200_000)); // ~3.6 MB, 4 chunks
    const { key, file, chunkSize } = await uploadEncrypted(plain, { name: 'secret plans.txt', mime: 'text/plain', size: plain.length });

    const info = (await a.get(`/api/files/${file.id}`)).body;
    assert.equal(info.encrypted, true);
    assert.equal(info.name, 'encrypted.bin');
    assert.ok(!JSON.stringify(info).includes('secret plans'));

    const dl = await a.download(file.id);
    assert.ok(!dl.data.includes('TOP-SECRET'), 'stored bytes must not contain plaintext');

    const back = await decryptAll(key, dl.data, chunkSize);
    assert.equal(sha(back), sha(plain));
    assert.deepEqual(await key.decryptMeta(info.meta), { name: 'secret plans.txt', mime: 'text/plain', size: plain.length });
  });

  it('a wrong key or tampered data cannot be decrypted', async () => {
    const plain = randomBytes(1500);
    const { key, file, chunkSize } = await uploadEncrypted(plain, { name: 'a', size: 1500 });
    const dl = await a.download(file.id);
    await assert.rejects(decryptAll(FileKey.generate(), dl.data, chunkSize));
    const flipped = Buffer.from(dl.data);
    flipped[10] ^= 1;
    await assert.rejects(decryptAll(key, flipped, chunkSize));
  });

  it('swapping the order of encrypted pieces is detected', async () => {
    const plain = randomBytes(3 * 1024 * 1024);
    const { key, file, chunkSize } = await uploadEncrypted(plain, { name: 'a', size: plain.length });
    const dl = (await a.download(file.id)).data;
    const swapped = Buffer.concat([dl.subarray(chunkSize, 2 * chunkSize), dl.subarray(0, chunkSize), dl.subarray(2 * chunkSize)]);
    await assert.rejects(decryptAll(key, swapped, chunkSize));
  });

  it('works together with a PIN and a one-time link', async () => {
    const plain = randomBytes(2 * 1024 * 1024 + 99);
    const { key, file, chunkSize } = await uploadEncrypted(plain, { name: 'both.bin', size: plain.length }, { pin: '2468', maxDownloads: 1 });
    const locked = (await a.get(`/api/files/${file.id}`)).body;
    assert.equal(locked.meta, undefined, 'encrypted details hidden until PIN');
    const { token, meta } = (await a.post(`/api/files/${file.id}/unlock`, { pin: '2468' })).body;
    assert.equal((await key.decryptMeta(meta)).name, 'both.bin');
    const dl = await a.download(file.id, `?t=${encodeURIComponent(token)}`);
    assert.equal(sha(await decryptAll(key, dl.data, chunkSize)), sha(plain));
    assert.ok([404, 410].includes((await a.download(file.id, `?t=${encodeURIComponent(token)}`)).status));
  });

  it('the phone fallback (@noble/ciphers) is byte-compatible with WebCrypto', async () => {
    const key = FileKey.generate();
    const plain = randomBytes(50_000);
    const viaWebCrypto = Buffer.from(await key.encryptChunk(5, plain));
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, 5n);
    assert.equal(sha(Buffer.from(gcm(key.raw, iv).encrypt(plain))), sha(viaWebCrypto));
    assert.equal(sha(Buffer.from(gcm(key.raw, iv).decrypt(viaWebCrypto))), sha(plain));
  });

  it('rejects encrypted uploads with missing or malformed details', async () => {
    assert.equal((await a.post('/api/uploads', { encrypted: true, size: 100 })).status, 400);
    assert.equal((await a.post('/api/uploads', { encrypted: true, size: 100, meta: '<script>' })).status, 400);
  });

  it('serves the browser crypto and QR libraries', async () => {
    for (const p of ['/vendor/noble/aes.js', '/vendor/noble/utils.js', '/vendor/noble/_polyval.js', '/vendor/qrcode.mjs']) {
      assert.equal((await fetch(srv.base + p)).status, 200, p);
    }
  });
});

describe('Hardening', () => {
  let srv;
  let a;
  before(async () => { srv = await startServer(); a = api(srv.base); });
  after(async () => { await srv.stop(); await srv.removeStorage(); });

  it('ignores path tricks in ids and static paths', async () => {
    for (const p of ['/api/files/..%2f..%2fserver.js', '/api/files/....//....//server.js/download',
      '/vendor/noble/..%2f..%2f..%2fserver.js', '/vendor/noble/../../../package.json', '/../server.js']) {
      const res = await fetch(srv.base + p);
      const text = await res.text();
      assert.ok(!text.includes('import express') && !text.includes('"dependencies"'), `${p} leaked a file`);
    }
  });

  it('sends security headers', async () => {
    const res = await fetch(srv.base + '/');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('forces downloads (an uploaded HTML file is never shown as a page)', async () => {
    const { file } = await uploadBuffer(srv.base, Buffer.from('<script>alert(1)</script>'), { name: 'evil.html', mime: 'text/html' });
    const dl = await a.download(file.id);
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
  });

  it('rate-limits starting uploads', async () => {
    const statuses = [];
    for (let i = 0; i < 35; i++) statuses.push((await a.post('/api/uploads', { name: 'x', size: 1 })).status);
    assert.ok(statuses.includes(429), `no 429 in ${statuses}`);
  });

  it('unknown API routes return JSON 404', async () => {
    const r = await a.get('/api/nope');
    assert.equal(r.status, 404);
    assert.ok(r.body.error);
  });
});
