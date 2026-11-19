import qrcode from '/vendor/qrcode.mjs';

/**
 * Sharing the QR code as an image.
 *
 * - makeQrCard(): draws a shareable PNG "card" (QR + file name) on a canvas.
 * - shareQr(): opens the device's own share sheet (WhatsApp, Telegram, Bluetooth,
 *   email, ...) with the image and the link. Returns false if the browser can't,
 *   so the page can show its own share menu instead.
 * - shareTargets(): links for that fallback menu.
 */

const W = 720;
const PAD = 60;

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** Draw the QR card and return it as a PNG Blob. */
export function makeQrCard(url, { title, subtitle }) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2; // white border around the code, in modules
  const cell = Math.floor((W - PAD * 2) / (count + quiet * 2));
  const qrSize = cell * (count + quiet * 2);

  const H = 150 + qrSize + 150;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Header: logo mark + name
  ctx.fillStyle = '#1f6feb';
  const mark = 34;
  const markX = W / 2 - 100;
  const markY = 52;
  const sq = (x, y) => ctx.fillRect(markX + x, markY + y, 14, 14);
  sq(0, 0); sq(20, 0); sq(0, 20); sq(20, 20);
  ctx.font = `700 40px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('ScanDrop', markX + mark + 18, markY + 17);

  // QR code
  const qx = Math.round((W - qrSize) / 2); // whole pixels keep the edges crisp
  const qy = 120;
  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(qx + (c + quiet) * cell, qy + (r + quiet) * cell, cell, cell);
    }
  }

  // Footer text
  ctx.textAlign = 'center';
  ctx.fillStyle = '#14171c';
  ctx.font = `600 30px ${font}`;
  ctx.fillText(fitText(ctx, title, W - PAD * 2), W / 2, qy + qrSize + 50);
  ctx.fillStyle = '#5f6774';
  ctx.font = `400 24px ${font}`;
  ctx.fillText(fitText(ctx, subtitle, W - PAD * 2), W / 2, qy + qrSize + 95);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function shareText(fileName) {
  return `I'm sending you "${fileName}" with ScanDrop. Scan the QR code or open the link:`;
}

/**
 * Open the system share sheet. Shares the image + link when the device allows
 * files, otherwise just the link. Returns true if a share sheet was shown.
 */
export async function shareQr({ url, fileName, image }) {
  if (typeof navigator.share !== 'function') return false;
  const text = shareText(fileName);
  const file = image ? new File([image], 'scandrop-qr.png', { type: 'image/png' }) : null;

  const withFile = { title: 'ScanDrop', text: `${text} ${url}`, files: [file] };
  const linkOnly = { title: 'ScanDrop', text, url };

  try {
    if (file && navigator.canShare?.(withFile)) await navigator.share(withFile);
    else await navigator.share(linkOnly);
    return true;
  } catch (err) {
    // User closed the sheet: that's fine, nothing else to do.
    if (err.name === 'AbortError') return true;
    return false;
  }
}

/** Links for the fallback share menu (used when there's no system share sheet). */
export function shareTargets({ url, fileName }) {
  const text = shareText(fileName);
  const t = encodeURIComponent(text);
  const u = encodeURIComponent(url);
  return [
    { label: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}` },
    { label: 'Telegram', href: `https://t.me/share/url?url=${u}&text=${t}` },
    { label: 'Email', href: `mailto:?subject=${encodeURIComponent(`File for you: ${fileName}`)}&body=${encodeURIComponent(`${text}\n\n${url}`)}` },
    { label: 'SMS', href: `sms:?&body=${encodeURIComponent(`${text} ${url}`)}` },
  ];
}

export function downloadBlob(blob, name) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}
