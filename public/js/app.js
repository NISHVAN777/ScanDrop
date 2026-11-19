import { formatBytes, formatDuration, timeLeft, downloadsText } from './utils.js';
import { ChunkedUpload } from './uploader.js';
import { qrDataUrl } from './qr.js';
import { startDirectSend } from './p2p.js';
import { makeQrCard, shareQr, shareTargets, downloadBlob } from './share.js';

const $ = (id) => document.getElementById(id);
const sections = { pick: $('pick'), uploading: $('uploading'), done: $('done'), direct: $('direct') };

let maxFileSize = Infinity;
let chosenFile = null;
let upload = null;   // current ChunkedUpload
let current = null;  // info of the finished file
let pollTimer = null;
let mode = 'upload'; // 'upload' (via server) or 'direct' (P2P)
let direct = null;   // running direct transfer

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
    const size = formatBytes(maxFileSize).replace('.0 ', ' '); // "1.0 GB" -> "1 GB"
    $('limitText').textContent =
      `The file waits safely on the server, so they can download it later. Up to ${size}.`;
    // Every other place on the page that mentions the upload limit
    document.querySelectorAll('.js-max-size').forEach((el) => { el.textContent = size; });
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
  if (mode === 'upload' && file.size > maxFileSize) {
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

// ---------- Mode: upload vs direct ----------
function setMode(next) {
  mode = next;
  const isDirect = mode === 'direct';
  $('modeUpload').classList.toggle('active', !isDirect);
  $('modeDirect').classList.toggle('active', isDirect);
  $('modeUpload').setAttribute('aria-selected', String(!isDirect));
  $('modeDirect').setAttribute('aria-selected', String(isDirect));
  $('uploadOptions').classList.toggle('hidden', isDirect);
  $('limitText').classList.toggle('hidden', isDirect);
  $('directText').classList.toggle('hidden', !isDirect);
  $('uploadBtn').textContent = isDirect ? 'Start direct transfer' : 'Create QR code';
  showError('');
  // A file that's too big to upload is fine for direct mode, and vice versa.
  if (chosenFile && !isDirect && chosenFile.size > maxFileSize) {
    resetPick();
    showError(`That file is over the ${formatBytes(maxFileSize)} upload limit. Use "Send directly" instead.`);
  }
}
$('modeUpload').addEventListener('click', () => setMode('upload'));
$('modeDirect').addEventListener('click', () => setMode('direct'));

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
  if (mode === 'direct') return startDirect(chosenFile);
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
    encrypt: $('e2eToggle').checked,
  });
});

async function startUpload(file, options) {
  showError('');
  show('uploading');
  $('upTitle').textContent = 'Starting…';
  $('upName').textContent = `${file.name} (${formatBytes(file.size)})`;
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
  $('upPercent').textContent = `${formatBytes(p.loaded)} of ${formatBytes(p.total)}`;
  $('upStats').textContent = p.speed > 0 ? `${formatDuration(p.eta)} left, ${formatBytes(p.speed)}/s` : '';
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
  // Drawn in the browser: an encrypted link's key must never be sent to the server.
  $('qr').src = qrDataUrl(info.url);
  $('shareLink').value = info.url;
  $('doneName').textContent = info.name;
  $('doneSize').textContent = formatBytes(info.size);
  $('donePin').textContent = info.protected ? `${pin} (share it separately)` : 'None';
  $('doneE2e').textContent = info.fileKey ? 'End-to-end encrypted 🔒' : 'Off';
  renderLive(info);
  show('done');
  prepareUploadShare();

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
      // Only take the live stats. The server doesn't know the real name or the
      // key part of the link for encrypted files, so never overwrite those.
      const { downloads, expiresAt, maxDownloads } = info;
      current = { ...current, downloads, expiresAt, maxDownloads };
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

// ---------- Share the QR (both screens) ----------
/**
 * Wire up the Share / Save image buttons. `getShare()` returns
 * { url, fileName, subtitle } for whatever is on screen right now.
 */
function setupSharing(prefix, getShare) {
  const menu = $(`${prefix}ShareMenu`);
  let cache = { url: null, blob: null };

  async function image() {
    const s = getShare();
    if (cache.url !== s.url) cache = { url: s.url, blob: await makeQrCard(s.url, { title: s.fileName, subtitle: s.subtitle }) };
    return cache.blob;
  }

  $(`${prefix}SaveQrBtn`).addEventListener('click', async () => {
    const s = getShare();
    if (!s.url) return;
    const safe = s.fileName.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 40) || 'file';
    downloadBlob(await image(), `scandrop-${safe}-qr.png`);
  });

  $(`${prefix}ShareBtn`).addEventListener('click', async () => {
    const s = getShare();
    if (!s.url) return;
    if (!menu.classList.contains('hidden')) return menu.classList.add('hidden');
    // Make the image first so the share sheet opens right away (it needs the click).
    const blob = cache.url === s.url ? cache.blob : null;
    if (await shareQr({ url: s.url, fileName: s.fileName, image: blob ?? await image() })) return;

    // No system share sheet (e.g. some desktop browsers): show our own menu.
    menu.replaceChildren(
      ...shareTargets(s).map(({ label, href }) => Object.assign(document.createElement('a'), {
        textContent: label, href, target: '_blank', rel: 'noopener noreferrer',
      })),
      Object.assign(document.createElement('button'), {
        type: 'button', textContent: 'Save image',
        onclick: () => $(`${prefix}SaveQrBtn`).click(),
      }),
      Object.assign(document.createElement('button'), {
        type: 'button', textContent: 'Copy link',
        onclick: async (e) => {
          try { await navigator.clipboard.writeText(s.url); } catch { /* ignore */ }
          e.target.textContent = 'Copied!';
        },
      }),
    );
    menu.classList.remove('hidden');
  });

  // Pre-draw the image as soon as a QR is shown, so sharing is instant.
  return () => { menu.classList.add('hidden'); image().catch(() => {}); };
}

const prepareUploadShare = setupSharing('q', () => ({
  url: current?.url,
  fileName: current?.name || 'file',
  subtitle: current?.protected ? 'Scan to download. PIN required.' : 'Scan with your phone camera to download',
}));
let directShare = { url: null, fileName: 'file' };
const prepareDirectShare = setupSharing('d', () => ({
  ...directShare,
  subtitle: 'Scan to receive directly from the sender',
}));

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

// ---------- Direct (P2P) ----------
async function startDirect(file) {
  if (typeof RTCPeerConnection === 'undefined') {
    return showError("This browser doesn't support direct transfers. Use Upload & share instead.");
  }
  showError('');
  $('dTitle').textContent = 'Setting up…';
  $('dSub').textContent = 'Keep this page open. The file goes straight to their device.';
  $('dName').textContent = file.name;
  $('dSize').textContent = formatBytes(file.size);
  $('dCount').textContent = '0 people';
  $('dProgressBox').classList.add('hidden');
  $('dQr').removeAttribute('src');
  show('direct');

  let started = 0;
  try {
    direct = await startDirectSend(file, {
      onReady: (url) => {
        $('dLink').value = url;
        $('dQr').src = qrDataUrl(url);
        directShare = { url, fileName: file.name };
        prepareDirectShare();
        $('dTitle').textContent = 'Waiting for someone to scan…';
      },
      onStatus: (state, text) => {
        $('dTitle').textContent = text;
        if (state === 'sending') {
          started = performance.now();
          $('dProgressBox').classList.remove('hidden');
        }
        if (state === 'waiting') $('dProgressBox').classList.add('hidden');
      },
      onProgress: (sent, total) => {
        const pct = (sent / total) * 100;
        const speed = sent / Math.max((performance.now() - started) / 1000, 0.001);
        $('dBar').style.width = `${pct.toFixed(1)}%`;
        $('dPercent').textContent = `${Math.floor(pct)}%`;
        $('dStats').textContent = `${formatDuration((total - sent) / speed)} left, ${formatBytes(speed)}/s`;
      },
      onDelivered: (count) => {
        $('dCount').textContent = `${count} ${count === 1 ? 'person' : 'people'}`;
      },
      onClosed: (reason) => {
        direct = null;
        if (reason !== 'Stopped.') {
          $('dTitle').textContent = reason;
          $('dSub').textContent = 'Start again to share the file.';
          $('dQr').style.opacity = '.25';
        }
      },
    });
  } catch (err) {
    show('pick');
    showError(err.message || 'Could not start a direct transfer.');
  }
}

$('dCopyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('dLink').value); } catch { $('dLink').select(); document.execCommand('copy'); }
  $('dCopyBtn').textContent = 'Copied!';
  setTimeout(() => { $('dCopyBtn').textContent = 'Copy'; }, 1500);
});

$('dStopBtn').addEventListener('click', () => {
  direct?.stop();
  direct = null;
  $('dQr').style.opacity = '';
  startOver();
});

window.addEventListener('beforeunload', (e) => {
  if (direct) e.preventDefault(); // closing the page ends the direct transfer
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
