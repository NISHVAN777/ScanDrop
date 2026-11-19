import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, api, sse, sleep } from './helpers.js';

describe('Send directly: signaling server', () => {
  let srv;
  let a;
  before(async () => { srv = await startServer(); a = api(srv.base); });
  after(async () => { await srv.stop(); await srv.removeStorage(); });

  const events = (roomId, token) => sse(`${srv.base}/api/p2p/${roomId}/events?token=${encodeURIComponent(token)}`);

  it('connects a sender and a receiver and relays messages both ways', async () => {
    const room = (await a.post('/api/p2p')).body;
    assert.match(room.url, /\/p\/[A-Za-z0-9_-]{12}$/);
    const sender = await events(room.roomId, room.token);
    assert.equal(sender.status, 200);

    const join = await a.post(`/api/p2p/${room.roomId}/join`);
    assert.equal(join.status, 200);
    const receiver = await events(room.roomId, join.body.token);
    assert.ok(await sender.next('peer-joined'), 'sender told that someone scanned');

    assert.equal((await a.post(`/api/p2p/${room.roomId}/signal`, { token: room.token, data: { sdp: 'offer' } })).status, 204);
    assert.deepEqual((await receiver.next('signal')).data, { sdp: 'offer' });
    assert.equal((await a.post(`/api/p2p/${room.roomId}/signal`, { token: join.body.token, data: { sdp: 'answer' } })).status, 204);
    assert.deepEqual((await sender.next('signal')).data, { sdp: 'answer' });

    sender.close();
    receiver.close();
  });

  it('receiver cannot join before the sender is connected', async () => {
    const room = (await a.post('/api/p2p')).body;
    assert.equal((await a.post(`/api/p2p/${room.roomId}/join`)).status, 409);
  });

  it('only one receiver at a time; the next one can join after', async () => {
    const room = (await a.post('/api/p2p')).body;
    const sender = await events(room.roomId, room.token);
    const first = (await a.post(`/api/p2p/${room.roomId}/join`)).body;
    const firstStream = await events(room.roomId, first.token);
    await sender.next('peer-joined');

    const busy = await a.post(`/api/p2p/${room.roomId}/join`);
    assert.equal(busy.status, 409);

    firstStream.close();
    assert.ok(await sender.next('peer-left'), 'sender told the receiver left');
    const second = await a.post(`/api/p2p/${room.roomId}/join`);
    assert.equal(second.status, 200);
    const secondStream = await events(room.roomId, second.body.token);
    assert.ok(await sender.next('peer-joined'));
    sender.close();
    secondStream.close();
  });

  it('closing the sender ends the room for everyone', async () => {
    const room = (await a.post('/api/p2p')).body;
    const sender = await events(room.roomId, room.token);
    const join = (await a.post(`/api/p2p/${room.roomId}/join`)).body;
    const receiver = await events(room.roomId, join.token);
    sender.close();
    assert.ok(await receiver.next('room-closed'), 'receiver told the sender left');
    await sleep(100);
    assert.equal((await a.post(`/api/p2p/${room.roomId}/join`)).status, 404);
  });

  it('refuses wrong tokens and unknown rooms', async () => {
    const room = (await a.post('/api/p2p')).body;
    const bad = await events(room.roomId, 'not-a-token');
    assert.equal(bad.status, 403);
    assert.equal((await a.post(`/api/p2p/${room.roomId}/signal`, { token: 'nope', data: {} })).status, 403);
    assert.equal((await a.post('/api/p2p/AAAAAAAAAAAA/join')).status, 404);
    assert.equal((await a.post('/api/p2p/../../x/join')).status, 404);
  });

  it('serves the receive page for direct links', async () => {
    const room = (await a.post('/api/p2p')).body;
    const res = await fetch(`${srv.base}/p/${room.roomId}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Receive/);
  });
});
