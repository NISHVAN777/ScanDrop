import { formatBytes, formatDuration } from './utils.js';
import { joinDirectTransfer } from './p2p.js';
import { openSink } from './save.js';

const $ = (id) => document.getElementById(id);

function show(name) {
  for (const id of ['connecting', 'offer', 'failed']) $(id).classList.toggle('hidden', id !== name);
}

function fail(message) {
  $('failReason').textContent = message;
  show('failed');
}

const match = location.pathname.match(/^\/p\/([A-Za-z0-9_-]+)\/?$/);
if (!match) fail('This link is not valid.');
else if (typeof RTCPeerConnection === 'undefined') fail("This browser doesn't support direct transfers. Ask the sender to use Upload & share.");
else start(match[1]);

async function start(roomId) {
  let started = 0;
  let done = false;

  try {
    await joinDirectTransfer(roomId, {
      onStatus: (state, text) => {
        if (state === 'connecting') $('status').textContent = text;
      },

      onOffer: (meta, accept) => {
        document.title = `${meta.name} — ScanDrop`;
        $('fileName').textContent = meta.name;
        $('fileSize').textContent = formatBytes(meta.size);
        show('offer');

        $('acceptBtn').onclick = async () => {
          let sink;
          try {
            sink = await openSink(meta.name, meta.mime); // needs the click, so it comes first
          } catch {
            return; // save dialog closed
          }
          $('acceptBtn').classList.add('hidden');
          $('progressBox').classList.remove('hidden');
          started = performance.now();
          accept(sink);
        };
      },

      onProgress: (received, total) => {
        const pct = (received / total) * 100;
        const speed = received / Math.max((performance.now() - started) / 1000, 0.001);
        $('bar').style.width = `${pct.toFixed(1)}%`;
        $('percent').textContent = `${Math.floor(pct)}% · ${formatBytes(received)} of ${formatBytes(total)}`;
        $('stats').textContent = `${formatBytes(speed)}/s · ${formatDuration((total - received) / speed)} left`;
      },

      onDone: () => {
        done = true;
        $('bar').style.width = '100%';
        $('percent').textContent = 'Received ✓';
        $('stats').textContent = '';
        $('keepOpen').textContent = 'Done! You can close this page.';
      },

      onError: (msg) => {
        if (!done) fail(msg);
      },
    });
  } catch (err) {
    fail(err.message || 'Could not join this transfer.');
  }
}
