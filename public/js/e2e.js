/**
 * End-to-end encryption for ScanDrop (AES-256-GCM).
 *
 * - A fresh random key is made for every file, in the sender's browser.
 * - The key is put in the share link after "#" (the URL fragment). Browsers never
 *   send the fragment to the server, so the server only ever stores ciphertext.
 * - The file is encrypted in pieces so huge files never need to fit in memory.
 *   Piece i uses nonce [0,0,0,0, i as 8-byte big-endian]; the details blob uses
 *   nonce [1,0,...]. Every nonce is unique per key, and reordering or dropping
 *   pieces makes decryption fail.
 *
 * Uses the browser's built-in WebCrypto when available. Phones opening a plain
 * http:// LAN address don't get WebCrypto (it needs HTTPS), so we fall back to
 * the audited pure-JS @noble/ciphers implementation - same format either way.
 */

export const TAG_BYTES = 16;
const KEY_BYTES = 32;

let nobleGcm = null;
async function noble() {
  if (!nobleGcm) ({ gcm: nobleGcm } = await import('/vendor/noble/aes.js'));
  return nobleGcm;
}
const subtle = globalThis.crypto?.subtle;

// ---------- base64url ----------

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- nonces ----------

function chunkNonce(index) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(index));
  return iv;
}
const META_NONCE = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

// ---------- key ----------

export class FileKey {
  constructor(raw) {
    if (raw.length !== KEY_BYTES) throw new Error('Invalid key.');
    this.raw = raw;
    this.cryptoKey = null;
  }

  static generate() {
    return new FileKey(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
  }

  static fromString(s) {
    return new FileKey(fromB64(s));
  }

  toString() {
    return toB64(this.raw);
  }

  async encrypt(nonce, data) {
    if (subtle) {
      this.cryptoKey ??= await subtle.importKey('raw', this.raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
      return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, this.cryptoKey, data));
    }
    return (await noble())(this.raw, nonce).encrypt(new Uint8Array(data));
  }

  async decrypt(nonce, data) {
    try {
      if (subtle) {
        this.cryptoKey ??= await subtle.importKey('raw', this.raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
        return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, this.cryptoKey, data));
      }
      return (await noble())(this.raw, nonce).decrypt(new Uint8Array(data));
    } catch {
      throw new Error('Could not decrypt. The link may be incomplete or the file was changed.');
    }
  }

  encryptChunk(index, plain) { return this.encrypt(chunkNonce(index), plain); }
  decryptChunk(index, cipher) { return this.decrypt(chunkNonce(index), cipher); }

  /** Encrypt the real file details so the server can't see them. */
  async encryptMeta(meta) {
    return toB64(await this.encrypt(META_NONCE, new TextEncoder().encode(JSON.stringify(meta))));
  }

  async decryptMeta(str) {
    return JSON.parse(new TextDecoder().decode(await this.decrypt(META_NONCE, fromB64(str))));
  }
}

/**
 * Size bookkeeping. The server stores the ciphertext in pieces of `chunkSize`
 * bytes, so each plaintext piece is 16 bytes (the auth tag) smaller.
 */
export function encryptedLayout(plainSize, chunkSize) {
  const plainChunk = chunkSize - TAG_BYTES;
  const chunks = Math.ceil(plainSize / plainChunk);
  return { plainChunk, chunks, encryptedSize: plainSize + chunks * TAG_BYTES };
}
