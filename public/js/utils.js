export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 || n >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.floor(seconds % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "in 23h 59m" style text for an expiry timestamp. */
export function timeLeft(expiresAt) {
  const s = (expiresAt - Date.now()) / 1000;
  return s <= 0 ? 'expired' : `in ${formatDuration(s)}`;
}

export function downloadsText(info) {
  if (info.maxDownloads === 0) return `${info.downloads} so far (unlimited)`;
  const left = Math.max(0, info.maxDownloads - info.downloads);
  return `${left} of ${info.maxDownloads} left`;
}
