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
/** Does this request (optionally a Range request) include the file's last byte? */
function includesLastByte(range, size) {
  if (!range) return true;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return true; // unusual/multi-range: treat as a full download
  const [, start, end] = m;
  if (start === '') return Number(end) > 0; // "bytes=-500" = the last 500 bytes
  return end === '' || Number(end) >= size - 1;
}

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
    encrypted: Boolean(record.encrypted),
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

    // A download counts only when it actually finishes. A transfer that breaks
    // halfway (bad Wi-Fi, phone locked, tab closed) doesn't use up the limit,
    // so a one-time link can be retried or resumed.
    //
    // "Finishes" = the request that delivers the last byte completes. That's
    // a normal full download, or the final part of a resumed (Range) one.
    const finishing = includesLastByte(req.headers.range, record.size);

    // While a finishing transfer is running it holds one of the allowed slots,
    // so two people can't both grab a one-time file at the same moment.
    const active = activeDownloads.get(record.id) || { total: 0, finishing: 0 };
    if (finishing && record.maxDownloads > 0 && record.downloads + active.finishing >= record.maxDownloads) {
      return res.status(409).json({
        error: 'Someone is downloading this file right now. Try again in a moment.',
        reason: 'in_progress',
      });
    }
    active.total += 1;
    if (finishing) active.finishing += 1;
    activeDownloads.set(record.id, active);

    res.download(record.diskPath, record.name, { dotfiles: 'allow' }, (err) => {
      active.total -= 1;
      if (finishing) active.finishing -= 1;
      if (active.total <= 0) activeDownloads.delete(record.id);

      const current = files.get(record.id);
      if (!err && finishing && current) files.update(record.id, { downloads: current.downloads + 1 });
      if (err && !res.headersSent) res.status(500).json({ error: 'Download failed.' });

      // Limit reached: delete as soon as no transfer is still running.
      if (active.total <= 0 && unavailableReason(files.get(record.id))) deleteFile(record.id);
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
