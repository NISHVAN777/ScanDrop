import { formatBytes, formatDuration, timeLeft, downloadsText } from './utils.js';
import { FileKey } from './e2e.js';
import { openSink } from './save.js';

const $ = (id) => document.getElementById(id);

let token = null;   // proves the PIN was entered (for protected files)
let fileKey = null; // decryption key from the link's "#" part (encrypted files)

function show(name) {
  for (const id of ['loading', 'locked', 'ready', 'gone']) $(id).classList.toggle('hidden', id !== name);
}

function gone(message) {
  $('goneReason').textContent = message;
  show('gone');
}

const withToken = (url) => (token ? `${url}?t=${encodeURIComponent(token)}` : url);

// A different key pasted into the same page: start over with it.
window.addEventListener('hashchange', () => location.reload());

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

  if (info.encrypted) {
    const keyText = location.hash.slice(1);
    try {
      fileKey = FileKey.fromString(keyText);
    } catch {
      return gone('This link is missing its secret key. Ask the sender for the full link, or scan the QR code again.');
    }
  }

  if (info.protected && !info.size) return showPinForm(id, info);
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
async function showFile(id, info) {
  if (info.encrypted) {
    try {
      const meta = await fileKey.decryptMeta(info.meta);
      info = { ...info, name: meta.name || 'file', mime: meta.mime, plainSize: meta.size };
    } catch (err) {
      return gone(err.message);
    }
  }

  document.title = `${info.name} | ScanDrop`;
  $('fileName').textContent = info.name;
  $('fileSize').textContent = formatBytes(info.plainSize ?? info.size);
  $('fileExpiry').textContent = timeLeft(info.expiresAt);
  $('fileDownloads').textContent = downloadsText(info);
  $('singleUse').classList.toggle('hidden', info.maxDownloads - info.downloads !== 1);
  $('e2eBadge').classList.toggle('hidden', !info.encrypted);

  const btn = $('downloadBtn');
  btn.href = withToken(`/api/files/${id}/download`);
  btn.addEventListener('click', (e) => {
    if (info.encrypted) {
      e.preventDefault();
      if (btn.dataset.busy) return;
      decryptAndSave(id, info, btn);
      return;
    }
    btn.textContent = 'Downloading…';
    // Refresh the details after the browser has started the download.
    setTimeout(() => recheck(id, btn), 2500);
  });

  show('ready');
}

/** Download the ciphertext as a stream, decrypt piece by piece, and save. */
async function decryptAndSave(id, info, btn) {
  $('dlError').classList.add('hidden');
  let sink;
  try {
    sink = await openSink(info.name, info.mime); // must run first: needs the click
  } catch {
    return; // user closed the save dialog
  }

  btn.dataset.busy = '1';
  btn.textContent = 'Downloading and decrypting…';
  $('dlProgress').classList.remove('hidden');
  const started = performance.now();

  try {
    const res = await fetch(withToken(`/api/files/${id}/download`));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Download failed (${res.status}).`);
    }

    const C = info.chunkSize;
    const reader = res.body.getReader();
    const buf = new Uint8Array(C);
    let fill = 0;
    let index = 0;
    let written = 0;

    const flush = async (bytes) => {
      const plain = await fileKey.decryptChunk(index++, bytes);
      await sink.write(plain);
      written += plain.length;
      const pct = (written / info.plainSize) * 100;
      const speed = written / ((performance.now() - started) / 1000);
      $('dlBar').style.width = `${pct.toFixed(1)}%`;
      $('dlPercent').textContent = `${formatBytes(written)} of ${formatBytes(info.plainSize)}`;
      $('dlStats').textContent = `${formatDuration((info.plainSize - written) / speed)} left, ${formatBytes(speed)}/s`;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let off = 0;
      while (off < value.length) {
        const n = Math.min(C - fill, value.length - off);
        buf.set(value.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill === C) {
          await flush(buf.slice());
          fill = 0;
        }
      }
    }
    if (fill > 0) await flush(buf.slice(0, fill));
    if (written !== info.plainSize) throw new Error('The download was incomplete. Please try again.');

    await sink.close();
    btn.textContent = sink.streaming ? 'Saved ✓' : 'Downloaded ✓';
    $('dlStats').textContent = '';
    // The server counts the download once its side finishes, a moment later.
    setTimeout(() => recheck(id, btn, true), 800);
  } catch (err) {
    sink.abort();
    $('dlError').textContent = err.message || 'Download failed.';
    $('dlError').classList.remove('hidden');
    btn.textContent = 'Try again';
  } finally {
    delete btn.dataset.busy;
  }
}

async function recheck(id, btn, keepLabel = false) {
  const res = await fetch(withToken(`/api/files/${id}`)).catch(() => null);
  if (!res) return;
  if (res.ok) {
    const info = await res.json();
    $('fileDownloads').textContent = downloadsText(info);
    if (!keepLabel) btn.textContent = 'Download again';
  } else {
    // Limit reached: the file is gone now (the transfer already happened).
    if (!keepLabel) btn.textContent = 'Download started';
    btn.removeAttribute('href');
    btn.classList.replace('btn-primary', 'btn-ghost');
    $('fileDownloads').textContent = 'Download limit reached';
  }
}
