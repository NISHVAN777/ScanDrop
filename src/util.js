import path from 'node:path';

/** Strip path parts and unsafe characters from a client-supplied filename. */
export function cleanFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim().slice(0, 200);
  return cleaned || 'file';
}

/** Accept only well-formed MIME types; anything else becomes a generic binary type. */
export function cleanMime(mime) {
  const m = String(mime || '').toLowerCase().trim();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) && m.length <= 100 ? m : 'application/octet-stream';
}

export const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
