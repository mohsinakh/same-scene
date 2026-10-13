export function randomToken(bytes = 18) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
}

export function createRoom() {
  return { room: `scene_${randomToken(12)}`, key: randomToken(24), role: 'host' };
}

export function roomLink(base, room, role = 'guest') {
  const url = new URL(base);
  url.hash = new URLSearchParams({ r: room.room, k: room.key, as: role }).toString();
  return url.href;
}

export function parseRoom(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (!p.has('r') && !p.has('k')) return null;
  if (!/^scene_[a-f0-9]{24}$/.test(p.get('r') || '') || !/^[a-f0-9]{48}$/.test(p.get('k') || '')) {
    throw new Error('This invite is incomplete or invalid. Ask your host for a new link.');
  }
  return { room: p.get('r'), key: p.get('k'), role: p.get('as') === 'host' ? 'host' : 'guest' };
}

export function allowedStreams(role) {
  const other = role === 'host' ? 'guest' : 'host';
  return [`${other}_control`, `${other}_voice`, `${other}_camera`, ...(role === 'guest' ? ['host_movie'] : [])];
}

export function discoverIds(detail) {
  const list = Array.isArray(detail?.list) ? detail.list : detail?.streamID ? [detail] : [];
  return list.map(item => typeof item === 'string' ? item : item?.streamID).filter(Boolean);
}

export function friendlyError(error) {
  const messages = {
    NotAllowedError: 'Permission was denied. Allow access in your browser and macOS settings, then try again.',
    NotFoundError: 'That device is not available. Choose another microphone, camera, or audio input.',
    NotReadableError: 'The device could not be opened. Close other apps using it and check macOS permissions.',
    OverconstrainedError: 'The selected device is unavailable. Refresh the device list and choose it again.',
    InvalidStateError: 'Click the share button again and keep this tab active while selecting a window.',
  };
  return messages[error?.name] || error?.message || 'Something went wrong. Please try again.';
}

// Store host and guest seats separately so following an invite never replaces a host room.
const savedRoomKey = role => `same-scene.saved-room.v1.${role}`;
export function loadSavedRoom(storage, role) {
  try {
    const hash = storage.getItem(savedRoomKey(role));
    const room = hash ? parseRoom(hash) : null;
    return room?.role === role ? room : null;
  } catch { return null; }
}
export function saveRoom(storage, room) {
  try {
    const hash = new URL(roomLink('https://same-scene.invalid/', room, room.role)).hash;
    const valid = parseRoom(hash);
    if (!valid || valid.role !== room.role) return false;
    storage.setItem(savedRoomKey(room.role), hash);
    return true;
  } catch { return false; }
}

export function loadHostSettings(storage) {
  try {
    const data = JSON.parse(storage.getItem('same-scene.host-settings.v1'));
    if (!data || typeof data !== 'object') return null;
    const result = {};
    for (const name of ['voice', 'camera', 'movie', 'output']) {
      const value = data[name];
      if (value && typeof value.id === 'string' && typeof value.label === 'string' && value.id.length < 500 && value.label.length < 300) result[name] = { id: value.id, label: value.label };
    }
    for (const [name, max] of [['boost', 400], ['movieVolume', 100], ['voiceVolume', 100]]) {
      if (Number.isFinite(data[name]) && data[name] >= (name === 'boost' ? 100 : 0) && data[name] <= max) result[name] = data[name];
    }
    for (const name of ['monitor', 'processing']) if (typeof data[name] === 'boolean') result[name] = data[name];
    return result;
  } catch { return null; }
}
export function saveHostSettings(storage, settings) {
  try { storage.setItem('same-scene.host-settings.v1', JSON.stringify(settings)); return true; } catch { return false; }
}
