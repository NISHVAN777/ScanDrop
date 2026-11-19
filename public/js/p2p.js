/**
 * Direct device-to-device transfer over WebRTC.
 *
 * The server only relays small "signal" messages so the two browsers can find
 * each other. The file goes over an encrypted WebRTC data channel (DTLS) and
 * never touches the server.
 *
 * Protocol on the data channel:
 *   sender   -> { type: 'meta', name, size, mime }
 *   receiver -> { type: 'start' }               (after the user taps Download)
 *   sender   -> binary pieces ... then { type: 'eof' }
 *   receiver -> { type: 'done' }
 */

const PIECE = 64 * 1024;          // bytes per data-channel message
const READ_BLOCK = 1024 * 1024;   // bytes read from disk at a time
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
  return data;
}

/** Event stream from the server + a way to send signals to the other device. */
class Signaling {
  constructor(roomId, token, handlers) {
    this.roomId = roomId;
    this.token = token;
    this.es = new EventSource(`/api/p2p/${roomId}/events?token=${encodeURIComponent(token)}`);
    for (const [event, fn] of Object.entries(handlers)) {
      this.es.addEventListener(event, (e) => fn(e.data ? JSON.parse(e.data) : {}));
    }
  }

  send(data) {
    return postJson(`/api/p2p/${this.roomId}/signal`, { token: this.token, data }).catch(() => {});
  }

  close() {
    this.es.close();
  }
}

/** A peer connection that queues ICE candidates until it's ready for them. */
function createPeer(iceServers, signaling) {
  const pc = new RTCPeerConnection({ iceServers });
  const pending = [];
  pc.onicecandidate = (e) => { if (e.candidate) signaling.send({ candidate: e.candidate }); };

  return {
    pc,
    async handleSignal(data) {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        while (pending.length) await pc.addIceCandidate(pending.shift()).catch(() => {});
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          signaling.send({ sdp: pc.localDescription });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else pending.push(data.candidate);
      }
    },
  };
}

async function getIceServers() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    return cfg.iceServers || [];
  } catch {
    return [];
  }
}

// =====================================================================
// Sender
// =====================================================================

/**
 * Share `file` directly. Each person who opens the link receives it, one at a time.
 * hooks: onReady(url), onStatus(text), onProgress(sent, total), onDelivered(count), onClosed(reason)
 */
export async function startDirectSend(file, hooks) {
  const iceServers = await getIceServers();
  const room = await postJson('/api/p2p');
  let peer = null;
  let channel = null;
  let delivered = 0;
  let justDelivered = false; // the current/last receiver got the whole file
  let stopped = false;

  const signaling = new Signaling(room.roomId, room.token, {
    'peer-joined': () => connect(),
    'peer-left': () => {
      teardown();
      hooks.onStatus?.('waiting', justDelivered
        ? 'Delivered ✓ Waiting for the next person to scan…'
        : 'The other device left. Waiting for someone to scan…');
    },
    signal: (data) => peer?.handleSignal(data),
    'room-closed': () => finish('This transfer was closed.'),
  });
  signaling.es.onerror = () => {
    if (!stopped && signaling.es.readyState === EventSource.CLOSED) finish('Lost connection to the server.');
  };

  hooks.onReady?.(room.url);

  function teardown() {
    try { channel?.close(); } catch { /* ignore */ }
    try { peer?.pc.close(); } catch { /* ignore */ }
    channel = null;
    peer = null;
  }

  function finish(reason) {
    if (stopped) return;
    stopped = true;
    teardown();
    signaling.close();
    hooks.onClosed?.(reason);
  }

  async function connect() {
    teardown();
    justDelivered = false;
    hooks.onStatus?.('connecting', 'Someone scanned the code. Connecting…');
    peer = createPeer(iceServers, signaling);
    const { pc } = peer;
    channel = pc.createDataChannel('file', { ordered: true });
    channel.binaryType = 'arraybuffer';
    const ch = channel;

    ch.onopen = () => {
      hooks.onStatus?.('connected', 'Connected. Waiting for them to accept…');
      ch.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type }));
    };
    ch.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data);
      if (msg.type === 'start') sendFile(ch).catch(() => {
        if (ch === channel) hooks.onStatus?.('waiting', 'Transfer interrupted. Waiting for someone to scan…');
      });
      if (msg.type === 'done') {
        delivered += 1;
        justDelivered = true;
        hooks.onDelivered?.(delivered);
        hooks.onStatus?.('waiting', 'Delivered ✓ Waiting for the next person to scan…');
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        hooks.onStatus?.('waiting', "Couldn't connect the two devices. Try being on the same Wi-Fi, or use Upload & share.");
      }
    };

    await pc.setLocalDescription(await pc.createOffer());
    signaling.send({ sdp: pc.localDescription });
  }

  async function sendFile(ch) {
    hooks.onStatus?.('sending', 'Sending…');
    ch.bufferedAmountLowThreshold = LOW_WATER;
    let offset = 0;
    while (offset < file.size) {
      const block = new Uint8Array(await file.slice(offset, offset + READ_BLOCK).arrayBuffer());
      for (let i = 0; i < block.length; i += PIECE) {
        if (ch.readyState !== 'open') throw new Error('closed');
        if (ch.bufferedAmount > HIGH_WATER) {
          await new Promise((resolve) => {
            ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; resolve(); };
          });
        }
        ch.send(block.subarray(i, i + PIECE));
      }
      offset += block.length;
      hooks.onProgress?.(offset, file.size);
    }
    ch.send(JSON.stringify({ type: 'eof' }));
    hooks.onStatus?.('finishing', 'Sent. Waiting for them to confirm…');
  }

  return { stop: () => finish('Stopped.') };
}

// =====================================================================
// Receiver
// =====================================================================

/**
 * Join a direct transfer.
 * hooks: onStatus(state, text), onOffer(meta, accept), onProgress(received, total), onDone(), onError(msg)
 * `accept(sink)` must be called with a sink from openSink() to start receiving.
 */
export async function joinDirectTransfer(roomId, hooks) {
  const iceServers = await getIceServers();
  const { token } = await postJson(`/api/p2p/${roomId}/join`);
  let peer = null;
  let finished = false;

  const signaling = new Signaling(roomId, token, {
    signal: async (data) => {
      if (data.sdp?.type === 'offer') setupPeer();
      await peer?.handleSignal(data);
    },
    'room-closed': () => {
      if (!finished) hooks.onError?.('The sender closed the page before the transfer finished.');
    },
  });

  hooks.onStatus?.('connecting', 'Connecting to the sender…');

  function setupPeer() {
    try { peer?.pc.close(); } catch { /* ignore */ }
    peer = createPeer(iceServers, signaling);
    const { pc } = peer;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && !finished) {
        hooks.onError?.("Couldn't connect to the sender's device. Try being on the same Wi-Fi.");
      }
    };
    pc.ondatachannel = (e) => receive(e.channel);
  }

  function receive(ch) {
    ch.binaryType = 'arraybuffer';
    let meta = null;
    let sink = null;
    let received = 0;
    let writing = Promise.resolve();

    ch.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.type === 'meta') {
          meta = msg;
          hooks.onStatus?.('ready', 'Connected');
          hooks.onOffer?.(meta, (s) => {
            sink = s;
            ch.send(JSON.stringify({ type: 'start' }));
            hooks.onStatus?.('receiving', 'Receiving…');
          });
        } else if (msg.type === 'eof') {
          writing = writing.then(async () => {
            if (received !== meta.size) throw new Error('The file arrived incomplete. Please try again.');
            await sink.close();
            finished = true;
            ch.send(JSON.stringify({ type: 'done' }));
            hooks.onDone?.();
            setTimeout(() => { signaling.close(); peer?.pc.close(); }, 1000);
          }).catch((err) => hooks.onError?.(err.message));
        }
        return;
      }
      if (!sink) return;
      const data = new Uint8Array(e.data);
      received += data.length;
      const now = received;
      writing = writing.then(() => sink.write(data));
      hooks.onProgress?.(now, meta.size);
    };
    ch.onclose = () => {
      if (!finished && sink) {
        sink.abort();
        hooks.onError?.('The connection closed before the file finished.');
      }
    };
  }

  return { close: () => { signaling.close(); peer?.pc.close(); } };
}
