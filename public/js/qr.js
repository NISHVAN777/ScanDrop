import qrcode from '/vendor/qrcode.mjs';

/**
 * Draw a QR code in the browser. Needed for encrypted links: their key lives in
 * the "#" part of the URL, which must never be sent to the server.
 */
export function qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 8, margin: 1, scalable: true });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
