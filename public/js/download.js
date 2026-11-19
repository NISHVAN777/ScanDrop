import { formatBytes, timeLeft, downloadsText } from './utils.js';

const $ = (id) => document.getElementById(id);

function show(name) {
  for (const id of ['loading', 'ready', 'gone']) $(id).classList.toggle('hidden', id !== name);
}

function gone(message) {
  $('goneReason').textContent = message;
  show('gone');
}

const match = location.pathname.match(/^\/d\/([A-Za-z0-9_-]+)\/?$/);

if (!match) {
  gone('This page does not exist.');
} else {
  load(match[1]);
}

async function load(id) {
  let res;
  try {
    res = await fetch(`/api/files/${id}`);
  } catch {
    return gone('Could not reach the server. Check your connection.');
  }
  const info = await res.json().catch(() => ({}));
  if (!res.ok) return gone(info.error || 'This link is invalid or has expired.');

  document.title = `${info.name} — ScanDrop`;
  $('fileName').textContent = info.name;
  $('fileSize').textContent = formatBytes(info.size);
  $('fileExpiry').textContent = timeLeft(info.expiresAt);
  $('fileDownloads').textContent = downloadsText(info);
  $('singleUse').classList.toggle('hidden', info.maxDownloads - info.downloads !== 1);

  const btn = $('downloadBtn');
  btn.href = `/api/files/${id}/download`;
  btn.addEventListener('click', () => {
    btn.textContent = 'Downloading…';
    // Refresh the details after the browser has started the download.
    setTimeout(() => recheck(id, btn), 2500);
  });

  show('ready');
}

async function recheck(id, btn) {
  const res = await fetch(`/api/files/${id}`).catch(() => null);
  if (!res) return;
  if (res.ok) {
    const info = await res.json();
    $('fileDownloads').textContent = downloadsText(info);
    btn.textContent = 'Download again';
  } else {
    // Single-use file: it's gone now, but the transfer already started.
    btn.textContent = 'Download started';
    btn.removeAttribute('href');
    btn.classList.replace('btn-primary', 'btn-ghost');
    $('fileDownloads').textContent = 'Download limit reached';
  }
}
