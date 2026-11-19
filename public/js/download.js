import { formatBytes, timeLeft, downloadsText } from './utils.js';

const $ = (id) => document.getElementById(id);

let token = null; // proves the PIN was entered (for protected files)

function show(name) {
  for (const id of ['loading', 'locked', 'ready', 'gone']) $(id).classList.toggle('hidden', id !== name);
}

function gone(message) {
  $('goneReason').textContent = message;
  show('gone');
}

const withToken = (url) => (token ? `${url}?t=${encodeURIComponent(token)}` : url);

const match = location.pathname.match(/^\/d\/([A-Za-z0-9_-]+)\/?$/);
if (!match) gone('This page does not exist.');
else load(match[1]);

async function load(id) {
  let res;
  try {
    res = await fetch(`/api/files/${id}`);
  } catch {
    return gone('Could not reach the server. Check your connection.');
  }
  const info = await res.json().catch(() => ({}));
  if (!res.ok) return gone(info.error || 'This link is invalid or has expired.');

  if (info.protected && !info.name) return showPinForm(id, info);
  showFile(id, info);
}

// ---------- PIN ----------
function showPinForm(id, info) {
  show('locked');
  if (info.locked) pinError('Too many wrong PINs. Please wait a few minutes and try again.');
  const input = $('pin');
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 8); });
  input.focus();

  $('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('unlockBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    $('pinError').classList.add('hidden');
    try {
      const res = await fetch(`/api/files/${id}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: input.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        token = body.token;
        return showFile(id, body);
      }
      if (res.status === 404 || res.status === 410) return gone(body.error);
      let msg = body.error || 'Could not unlock.';
      if (body.attemptsLeft) msg += ` ${body.attemptsLeft} ${body.attemptsLeft === 1 ? 'try' : 'tries'} left.`;
      pinError(msg);
      input.select();
    } catch {
      pinError('Could not reach the server. Check your connection.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock';
    }
  });
}

function pinError(msg) {
  $('pinError').textContent = msg;
  $('pinError').classList.remove('hidden');
}

// ---------- File ----------
function showFile(id, info) {
  document.title = `${info.name} — ScanDrop`;
  $('fileName').textContent = info.name;
  $('fileSize').textContent = formatBytes(info.size);
  $('fileExpiry').textContent = timeLeft(info.expiresAt);
  $('fileDownloads').textContent = downloadsText(info);
  $('singleUse').classList.toggle('hidden', info.maxDownloads - info.downloads !== 1);

  const btn = $('downloadBtn');
  btn.href = withToken(`/api/files/${id}/download`);
  btn.addEventListener('click', () => {
    btn.textContent = 'Downloading…';
    // Refresh the details after the browser has started the download.
    setTimeout(() => recheck(id, btn), 2500);
  });

  show('ready');
}

async function recheck(id, btn) {
  const res = await fetch(withToken(`/api/files/${id}`)).catch(() => null);
  if (!res) return;
  if (res.ok) {
    const info = await res.json();
    $('fileDownloads').textContent = downloadsText(info);
    btn.textContent = 'Download again';
  } else {
    // Limit reached: the file is gone now, but the transfer already started.
    btn.textContent = 'Download started';
    btn.removeAttribute('href');
    btn.classList.replace('btn-primary', 'btn-ghost');
    $('fileDownloads').textContent = 'Download limit reached';
  }
}
