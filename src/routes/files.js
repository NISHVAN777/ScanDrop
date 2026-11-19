import express from 'express';
import QRCode from 'qrcode';

import { PIN_MAX_ATTEMPTS, PIN_LOCK_MS } from '../config.js';
import { isValidId, unavailableReason } from '../store.js';
import { verifyPin, hashToken, safeEqual } from '../security.js';

/**
 *   GET    /api/files/:id            info (limited if PIN-protected and not unlocked)
 *   POST   /api/files/:id/unlock     { pin } -> { token, ...info }
 *   GET    /api/files/:id/qr.svg     QR code of the share link
 *   GET    /api/files/:id/download   the file (?t=<token> if PIN-protected)
 *   DELETE /api/files/:id            owner only (X-Owner-Token header)
 */
export function fileRoutes({ files, limits, tokens, publicInfo, shareUrl, deleteFile, activeDownloads }) {
  const r = express.Router();

  const MESSAGES = {
    not_found: 'This file does not exist or was already deleted.',
    expired: 'This link has expired.',
    limit_reached: 'This file reached its download limit.',
  };

  function findAvailable(req, res) {
    const { id } = req.params;
    const record = isValidId(id) ? files.get(id) : undefined;
    const reason = unavailableReason(record);
    if (reason) {
      res.status(reason === 'not_found' ? 404 : 410).json({ error: MESSAGES[reason], reason });
      return null;
    }
    return record;
  }

  const isOwner = (req, record) => {
    const t = req.get('X-Owner-Token');
    return Boolean(t && record.ownerTokenHash && safeEqual(hashToken(t), record.ownerTokenHash));
  };

  /** True if this request may see the file's details and download it. */
  const hasAccess = (req, record) =>
    !record.pinHash || isOwner(req, record) || tokens.verify(record.id, req.query.t);

  const lockedInfo = (record) => ({
    id: record.id,
    protected: true,
    locked: record.lockedUntil > Date.now(),
    expiresAt: record.expiresAt,
    maxDownloads: record.maxDownloads,
    downloads: record.downloads,
  });

  r.get('/:id', (req, res) => {
    const record = findAvailable(req, res);
    if (!record) return;
    res.json(hasAccess(req, record) ? publicInfo(record) : lockedInfo(record));
  });

  r.post('/:id/unlock', limits.unlock, express.json({ limit: '1kb' }), (req, res) => {
    const record = findAvailable(req, res);
    if (!record) return;
    if (!record.pinHash) return res.json({ ...publicInfo(record), token: null });

    const now = Date.now();
    if (record.lockedUntil > now) {
      const mins = Math.ceil((record.lockedUntil - now) / 60000);
      return res.status(429).json({ error: `Too many wrong PINs. Try again in ${mins} min.`, locked: true });
    }

    const pin = String(req.body?.pin ?? '');
    if (!verifyPin(pin, record.pinHash)) {
      const attempts = (record.failedPinAttempts || 0) + 1;
      if (attempts >= PIN_MAX_ATTEMPTS) {
        files.update(record.id, { failedPinAttempts: 0, lockedUntil: now + PIN_LOCK_MS });
        return res.status(429).json({
          error: `Too many wrong PINs. Locked for ${Math.round(PIN_LOCK_MS / 60000)} min.`,
          locked: true,
        });
      }
      files.update(record.id, { failedPinAttempts: attempts });
      return res.status(401).json({ error: 'Wrong PIN.', attemptsLeft: PIN_MAX_ATTEMPTS - attempts });
    }

    files.update(record.id, { failedPinAttempts: 0 });
    res.json({ ...publicInfo(record), token: tokens.issue(record.id) });
  });

  r.get('/:id/qr.svg', async (req, res) => {
    const record = findAvailable(req, res);
    if (!record) return;
    const svg = await QRCode.toString(shareUrl(record.id), {
      type: 'svg', margin: 1, errorCorrectionLevel: 'M',
    });
    res.type('image/svg+xml').setHeader('Cache-Control', 'no-store');
    res.send(svg);
  });

  r.get('/:id/download', (req, res) => {
    const record = findAvailable(req, res);
    if (!record) return;
    if (!hasAccess(req, record)) {
      return res.status(401).json({ error: 'This file is PIN-protected. Enter the PIN on the download page.' });
    }

    // Resumed downloads send a Range header (e.g. "bytes=5000-"). Only the
    // request that starts from the beginning counts as a new download.
    const range = req.headers.range;
    if (!range || /^bytes=0-/.test(range)) {
      files.update(record.id, { downloads: record.downloads + 1 });
    }

    activeDownloads.set(record.id, (activeDownloads.get(record.id) || 0) + 1);
    res.download(record.diskPath, record.name, { dotfiles: 'allow' }, (err) => {
      const left = (activeDownloads.get(record.id) || 1) - 1;
      if (left > 0) activeDownloads.set(record.id, left);
      else activeDownloads.delete(record.id);

      if (err && !res.headersSent) res.status(500).json({ error: 'Download failed.' });
      // Limit reached: delete as soon as the last transfer finishes.
      if (left <= 0 && unavailableReason(files.get(record.id))) deleteFile(record.id);
    });
  });

  r.delete('/:id', (req, res) => {
    const { id } = req.params;
    const record = isValidId(id) ? files.get(id) : undefined;
    if (!record) return res.status(404).json({ error: 'Not found.' });
    if (!isOwner(req, record)) return res.status(403).json({ error: 'Only the sender can delete this file.' });
    deleteFile(id);
    res.status(204).end();
  });

  return r;
}
