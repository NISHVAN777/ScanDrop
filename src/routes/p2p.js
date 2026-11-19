import express from 'express';

import { P2P_ROOM_TTL } from '../config.js';
import { newId, isValidId } from '../store.js';
import { newOwnerToken, safeEqual } from '../security.js';

/**
 * Signaling for direct (peer-to-peer) transfers.
 *
 * The file itself never touches the server: browsers connect to each other with
 * WebRTC. The server only passes small "how to reach me" messages between them,
 * using Server-Sent Events (server -> browser) and POST (browser -> server).
 *
 *   POST /api/p2p                      sender opens a room -> { roomId, token, url }
 *   POST /api/p2p/:id/join             receiver joins -> { token }
 *   GET  /api/p2p/:id/events?token=    event stream: peer-joined, peer-left, signal
 *   POST /api/p2p/:id/signal           { token, data } relayed to the other side
 *
 * One receiver at a time. The room closes when the sender leaves.
 */
export function p2pRoutes({ limits, p2pUrl }) {
  const r = express.Router();
  const rooms = new Map(); // id -> { id, createdAt, sender: Peer, receiver: Peer|null }
  // Peer = { token, res: Response|null }

  function emit(peer, event, data) {
    if (!peer?.res) return false;
    peer.res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    return true;
  }

  function closeRoom(room) {
    rooms.delete(room.id);
    for (const p of [room.sender, room.receiver]) {
      if (p?.res) {
        emit(p, 'room-closed');
        p.res.end();
      }
    }
  }

  /** Which side of the room a token belongs to. */
  function roleOf(room, token) {
    if (typeof token !== 'string' || !token) return null;
    if (safeEqual(token, room.sender.token)) return 'sender';
    if (room.receiver && safeEqual(token, room.receiver.token)) return 'receiver';
    return null;
  }

  function getRoom(req, res) {
    const room = isValidId(req.params.id) ? rooms.get(req.params.id) : undefined;
    if (!room) {
      res.status(404).json({ error: 'This direct transfer has ended. Ask the sender to share again.' });
      return null;
    }
    return room;
  }

  // Keep event streams alive through proxies, and expire old rooms.
  setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (now - room.createdAt > P2P_ROOM_TTL) { closeRoom(room); continue; }
      for (const p of [room.sender, room.receiver]) p?.res?.write(': ping\n\n');
    }
  }, 25_000).unref();

  r.post('/', limits.createRoom, (req, res) => {
    const id = newId();
    const token = newOwnerToken();
    rooms.set(id, { id, createdAt: Date.now(), sender: { token, res: null }, receiver: null });
    res.status(201).json({ roomId: id, token, url: p2pUrl(id) });
  });

  r.post('/:id/join', limits.unlock, (req, res) => {
    const room = getRoom(req, res);
    if (!room) return;
    if (!room.sender.res) {
      return res.status(409).json({ error: 'The sender is not connected right now.' });
    }
    if (room.receiver?.res) {
      return res.status(409).json({ error: 'Someone else is receiving this file right now. Try again in a moment.' });
    }
    const token = newOwnerToken();
    room.receiver = { token, res: null };
    res.json({ token });
  });

  r.get('/:id/events', (req, res) => {
    const room = getRoom(req, res);
    if (!room) return;
    const role = roleOf(room, req.query.token);
    if (!role) return res.status(403).json({ error: 'Not allowed.' });

    const me = room[role];
    if (me.res) me.res.end(); // replace an older stream from the same peer
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    me.res = res;

    // Tell the sender when a receiver is ready to connect.
    if (role === 'receiver') emit(room.sender, 'peer-joined');
    else if (room.receiver?.res) emit(room.sender, 'peer-joined');

    req.on('close', () => {
      if (me.res !== res) return; // already replaced
      me.res = null;
      if (!rooms.has(room.id)) return;
      if (role === 'sender') {
        closeRoom(room);
      } else {
        room.receiver = null;
        emit(room.sender, 'peer-left');
      }
    });
  });

  r.post('/:id/signal', express.json({ limit: '64kb' }), (req, res) => {
    const room = getRoom(req, res);
    if (!room) return;
    const role = roleOf(room, req.body?.token);
    if (!role) return res.status(403).json({ error: 'Not allowed.' });
    const other = role === 'sender' ? room.receiver : room.sender;
    if (!emit(other, 'signal', req.body.data)) {
      return res.status(409).json({ error: 'The other device is not connected.' });
    }
    res.status(204).end();
  });

  return r;
}
