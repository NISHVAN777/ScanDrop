import { formatBytes, formatDuration, timeLeft, downloadsText } from './utils.js';

const $ = (id) => document.getElementById(id);
const sections = { pick: $('pick'), uploading: $('uploading'), done: $('done') };

let maxFileSize = Infinity;
let chosenFile = null;
let currentXhr = null;
let current = null; // info of the uploaded file
let pollTimer = null;

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

// ---------- Upload ----------
$('uploadBtn').addEventListener('click', () => {
  if (!chosenFile) return;
  upload(chosenFile);
});

function upload(file) {
  showError('');
  show('uploading');
  $('upName').textContent = `${file.name} · ${formatBytes(file.size)}`;
  $('bar').style.width = '0%';
  $('upPercent').textContent = '0%';
  $('upStats').textContent = '';

  const form = new FormData();
  // Fields first, then the file.
  form.append('expiry', $('expiry').value);
  form.append('maxDownloads', $('maxDownloads').value);
  form.append('file', file, file.name);

  // XMLHttpRequest (not fetch) because it reports upload progress.
  const xhr = new XMLHttpRequest();
  currentXhr = xhr;
  const started = performance.now();

  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = (e.loaded / e.total) * 100;
    const secs = (performance.now() - started) / 1000;
    const speed = e.loaded / Math.max(secs, 0.001);
    const eta = (e.total - e.loaded) / speed;
    $('bar').style.width = `${pct.toFixed(1)}%`;
    $('upPercent').textContent = pct >= 100 ? 'Finishing…' : `${Math.floor(pct)}%`;
    $('upStats').textContent = `${formatBytes(speed)}/s · ${formatDuration(eta)} left`;
  };

  xhr.onload = () => {
    currentXhr = null;
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
    if (xhr.status === 201) {
      showResult(body);
    } else {
      show('pick');
      showError(body.error || `Upload failed (error ${xhr.status}).`);
    }
  };
  xhr.onerror = () => {
    currentXhr = null;
    show('pick');
    showError('Network error. Check your connection and try again.');
  };
  xhr.onabort = () => {
    currentXhr = null;
    show('pick');
  };

  xhr.open('POST', '/api/upload');
  xhr.send(form);
}

$('cancelBtn').addEventListener('click', () => currentXhr && currentXhr.abort());

// ---------- Result ----------
function showResult(info) {
  current = info;
  $('qr').src = `/api/files/${info.id}/qr.svg`;
  $('shareLink').value = info.url;
  $('doneName').textContent = info.name;
  $('doneSize').textContent = formatBytes(info.size);
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
    const res = await fetch(`/api/files/${current.id}`);
    if (res.ok) {
      current = await res.json();
      renderLive(current);
    } else {
      const body = await res.json().catch(() => ({}));
      clearInterval(pollTimer);
      $('doneExpiry').textContent = '—';
      $('doneDownloads').textContent =
        body.reason === 'limit_reached' ? 'Download limit reached, file deleted' : 'File no longer available';
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
  await fetch(`/api/files/${current.id}`, { method: 'DELETE' }).catch(() => {});
  startOver();
});

function startOver() {
  clearInterval(pollTimer);
  current = null;
  $('qr').removeAttribute('src');
  $('qr').style.opacity = '';
  resetPick();
  show('pick');
}
