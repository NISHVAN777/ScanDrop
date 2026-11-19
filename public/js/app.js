import { formatBytes, formatDuration, timeLeft, downloadsText } from './utils.js';
import { ChunkedUpload } from './uploader.js';

const $ = (id) => document.getElementById(id);
const sections = { pick: $('pick'), uploading: $('uploading'), done: $('done') };

let maxFileSize = Infinity;
let chosenFile = null;
let upload = null;   // current ChunkedUpload
let current = null;  // info of the finished file
let pollTimer = null;

// The sender's secret for each file (needed to delete it / see stats of PIN files).
const ownerKey = (id) => `scandrop:owner:${id}`;
const getOwnerToken = (id) => { try { return localStorage.getItem(ownerKey(id)); } catch { return null; } };
const setOwnerToken = (id, t) => { try { localStorage.setItem(ownerKey(id), t); } catch { /* ignore */ } };
const ownerHeaders = (id) => {
  const t = (current && current.id === id && current.ownerToken) || getOwnerToken(id);
  return t ? { 'X-Owner-Token': t } : {};
};

function show(name) {
  for (const [key, el] of Object.entries(sections)) el.classList.toggle('hidden', key !== name);
}

function showError(msg) {
  const box = $('pickError');
  box.textContent = msg;
  box.classList.toggle('hidden', !msg);
}

// ---------- Load server limits ----------
fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    maxFileSize = cfg.maxFileSize;
    $('limitText').textContent =
      `Drop a file, get a QR code, scan it on another device. Up to ${formatBytes(maxFileSize)}.`;
  })
  .catch(() => {});

// ---------- Choose a file ----------
const dropzone = $('dropzone');
const fileInput = $('fileInput');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => choose(fileInput.files[0]));

['dragenter', 'dragover'].forEach((t) => dropzone.addEventListener(t, (e) => {
  e.preventDefault();
  dropzone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragging');
}));
dropzone.addEventListener('drop', (e) => choose(e.dataTransfer.files[0]));

// Allow dropping anywhere on the page without the browser opening the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function choose(file) {
  showError('');
  if (!file) return;
  if (file.size === 0) return showError('That file is empty.');
  if (file.size > maxFileSize) {
    return showError(`That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxFileSize)}.`);
  }
  chosenFile = file;
  $('selName').textContent = file.name;
  $('selSize').textContent = formatBytes(file.size);
  dropzone.classList.add('hidden');
  $('selected').classList.remove('hidden');
}

function resetPick() {
  chosenFile = null;
  fileInput.value = '';
  dropzone.classList.remove('hidden');
  $('selected').classList.add('hidden');
}

$('clearBtn').addEventListener('click', resetPick);

// ---------- PIN option ----------
$('pinToggle').addEventListener('change', () => {
  const on = $('pinToggle').checked;
  $('pinRow').classList.toggle('hidden', !on);
  if (on) $('pin').focus();
});
$('pin').addEventListener('input', () => {
  $('pin').value = $('pin').value.replace(/\D/g, '').slice(0, 8);
});

// ---------- Upload ----------
$('uploadBtn').addEventListener('click', () => {
  if (!chosenFile) return;
  const pin = $('pinToggle').checked ? $('pin').value : '';
  if ($('pinToggle').checked && !/^\d{4,8}$/.test(pin)) {
    showError('PIN must be 4 to 8 digits.');
    $('pin').focus();
    return;
  }
  startUpload(chosenFile, {
    expiry: $('expiry').value,
    maxDownloads: Number($('maxDownloads').value),
    pin,
  });
});

async function startUpload(file, options) {
  showError('');
  show('uploading');
  $('upTitle').textContent = 'Starting…';
  $('upName').textContent = `${file.name} · ${formatBytes(file.size)}`;
  $('bar').style.width = '0%';
  $('upPercent').textContent = '0%';
  $('upStats').textContent = '';
  $('upNote').textContent = '';
  $('pauseBtn').textContent = 'Pause';
  $('pauseBtn').disabled = false;

  upload = new ChunkedUpload(file, options, { onProgress, onState });
  try {
    const info = await upload.start();
    if (info) finish(info, options.pin);
  } catch (err) {
    if (upload?.state === 'cancelled') return;
    show('pick');
    showError(err.message || 'Upload failed.');
  }
}

function onProgress(p) {
  const pct = (p.loaded / p.total) * 100;
  $('bar').style.width = `${pct.toFixed(1)}%`;
  $('upPercent').textContent = `${Math.floor(pct)}% · ${formatBytes(p.loaded)} of ${formatBytes(p.total)}`;
  $('upStats').textContent = p.speed > 0 ? `${formatBytes(p.speed)}/s · ${formatDuration(p.eta)} left` : '';
}

function onState(state, detail) {
  if (state === 'uploading') {
    $('upTitle').textContent = 'Uploading…';
    $('pauseBtn').textContent = 'Pause';
    $('upNote').textContent = detail?.resumed
      ? 'Continuing your earlier upload. Parts already sent are skipped.'
      : '';
  } else if (state === 'paused') {
    $('upTitle').textContent = 'Paused';
    $('pauseBtn').textContent = 'Resume';
    $('upStats').textContent = '';
    $('upNote').textContent = detail?.reason
      ? `${detail.reason} Press Resume when you're back online. Your progress is saved.`
      : 'Your progress is saved. You can even close this page and pick the same file again later.';
  } else if (state === 'completing') {
    $('upTitle').textContent = 'Finishing…';
    $('pauseBtn').disabled = true;
    $('upStats').textContent = '';
  }
}

$('pauseBtn').addEventListener('click', async () => {
  if (!upload) return;
  if (upload.state === 'uploading') return upload.pause();
  if (upload.state === 'paused') {
    try {
      const info = await upload.resume();
      if (info) finish(info, upload.options.pin);
    } catch (err) {
      show('pick');
      showError(err.message || 'Upload failed.');
    }
  }
});

$('cancelBtn').addEventListener('click', async () => {
  if (!upload) return;
  await upload.cancel();
  upload = null;
  show('pick');
});

// Warn before closing the tab mid-upload (progress is saved, but still).
window.addEventListener('beforeunload', (e) => {
  if (upload?.state === 'uploading') e.preventDefault();
});

// ---------- Result ----------
function finish(info, pin) {
  upload = null;
  setOwnerToken(info.id, info.ownerToken);
  current = info;
  $('qr').src = `/api/files/${info.id}/qr.svg`;
  $('shareLink').value = info.url;
  $('doneName').textContent = info.name;
  $('doneSize').textContent = formatBytes(info.size);
  $('donePin').textContent = info.protected ? `${pin} (share it separately)` : 'None';
  renderLive(info);
  show('done');

  // Keep download count / expiry fresh while the sender watches.
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 4000);
}

function renderLive(info) {
  $('doneExpiry').textContent = timeLeft(info.expiresAt);
  $('doneDownloads').textContent = downloadsText(info);
}

async function refresh() {
  if (!current) return;
  try {
    const res = await fetch(`/api/files/${current.id}`, { headers: ownerHeaders(current.id) });
    if (res.ok) {
      const info = await res.json();
      current = { ...current, ...info };
      renderLive(current);
    } else {
      const body = await res.json().catch(() => ({}));
      clearInterval(pollTimer);
      $('doneExpiry').textContent = '—';
      $('doneDownloads').textContent =
        body.reason === 'limit_reached' || body.reason === 'not_found'
          ? 'Downloaded. File deleted.'
          : 'File no longer available';
      $('qr').style.opacity = '.25';
    }
  } catch { /* offline: try again next tick */ }
}

$('copyBtn').addEventListener('click', async () => {
  const input = $('shareLink');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  $('copyBtn').textContent = 'Copied!';
  setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 1500);
});

$('newBtn').addEventListener('click', startOver);

$('deleteBtn').addEventListener('click', async () => {
  if (!current) return;
  if (!confirm('Delete this file now? The QR code will stop working.')) return;
  await fetch(`/api/files/${current.id}`, { method: 'DELETE', headers: ownerHeaders(current.id) }).catch(() => {});
  try { localStorage.removeItem(ownerKey(current.id)); } catch { /* ignore */ }
  startOver();
});

function startOver() {
  clearInterval(pollTimer);
  current = null;
  $('qr').removeAttribute('src');
  $('qr').style.opacity = '';
  $('pin').value = '';
  $('pinToggle').checked = false;
  $('pinRow').classList.add('hidden');
  resetPick();
  show('pick');
}
