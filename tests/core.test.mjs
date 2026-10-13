import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, roomLink, parseRoom, allowedStreams, discoverIds } from '../core.js';
test('invites round trip with credentials only in fragment and guest role', () => {
  const room = createRoom();
  const url = new URL(roomLink('https://example.com/movie-together/', room));
  assert.equal(url.search, '');
  assert.equal(url.pathname, '/movie-together/');
  assert.deepEqual(parseRoom(url.hash), { ...room, role: 'guest' });
  assert.equal(parseRoom(new URL(roomLink(url.href, room, 'host')).hash).role, 'host');
  assert.notEqual(createRoom().key, room.key);
});
test('malformed and partial invites fail rather than join a shared default room', () => {
  assert.equal(parseRoom(''), null);
  for (const hash of ['#r=hello', '#k=bad', '#r=scene_x&k=123', '#r=scene_%3Cscript%3E&k=x']) {
    assert.throws(() => parseRoom(hash));
  }
});
test('host never subscribes to its own outgoing movie or voice', () => {
  assert.deepEqual(allowedStreams('host'), ['guest_control', 'guest_voice', 'guest_camera']);
  assert.ok(allowedStreams('guest').includes('host_movie'));
  assert.ok(!allowedStreams('guest').includes('guest_voice'));
});
test('all SDK room-discovery event forms are supported', () => {
  assert.deepEqual(discoverIds({ list: ['host_voice', { streamID: 'host_movie' }] }), ['host_voice', 'host_movie']);
  assert.deepEqual(discoverIds({ streamID: 'guest_camera' }), ['guest_camera']);
  assert.deepEqual(discoverIds({ list: [null, {}] }), []);
});

test('saved host and guest seats survive reload independently', async () => {
  const { saveRoom, loadSavedRoom } = await import('../core.js');
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const host = createRoom(), guest = { ...createRoom(), role: 'guest' };
  assert.equal(saveRoom(storage, host), true);
  assert.equal(saveRoom(storage, guest), true);
  assert.deepEqual(loadSavedRoom(storage, 'host'), host);
  assert.deepEqual(loadSavedRoom(storage, 'guest'), guest);
  assert.equal(roomLink('https://example.com/', loadSavedRoom(storage, 'host')), roomLink('https://example.com/', host));
  const nextHost = createRoom();
  saveRoom(storage, nextHost);
  assert.deepEqual(loadSavedRoom(storage, 'host'), nextHost);
  assert.deepEqual(loadSavedRoom(storage, 'guest'), guest);
  assert.deepEqual(parseRoom(new URL(roomLink('https://example.com/', host)).hash), { ...host, role: 'guest' });
});
test('invalid or unavailable room storage never crashes or restores the wrong role', async () => {
  const { saveRoom, loadSavedRoom } = await import('../core.js');
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.equal(loadSavedRoom(blocked, 'host'), null);
  assert.equal(saveRoom(blocked, createRoom()), false);
  assert.equal(loadSavedRoom({ getItem: () => '#r=bad&k=bad' }, 'host'), null);
  const guestHash = new URL(roomLink('https://example.com/', createRoom())).hash;
  assert.equal(loadSavedRoom({ getItem: () => guestHash }, 'host'), null);
});
