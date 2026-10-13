import { createRoom, parseRoom, roomLink, allowedStreams, discoverIds, friendlyError } from './core.js';

const $ = id => document.getElementById(id);
const state = {
  room: null, receiver: null, clients: new Set(), joined: false, joining: false, leaving: false,
  views: new Map(), incoming: new Map(), voice: null, camera: null, movie: null,
  heartbeat: null, lastSeen: 0, peer: false, movieBusy: false, audioContext: null,
  movieNode: null, movieDestination: null, movieGain: null,
};
let pendingInvite = null;

function notice(message, error = false) {
  $('notice-message').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
}
function showHelp() { if (!$('help-dialog').open) $('help-dialog').showModal(); }
function connection(text, live = false) {
  $('connection-text').textContent = text;
  $('connection-status').classList.toggle('live', live);
}
function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }
function setSelfStatus() {
  $('self-status').textContent = state.voice && state.camera ? 'Mic & camera on' : state.voice ? 'Mic on · camera off' : state.camera ? 'Camera on · mic off' : 'Mic & camera off';
  $('mic-label').textContent = state.voice ? 'Mic on' : 'Mic off';
  $('camera-label').textContent = state.camera ? 'Camera on' : 'Camera off';
  $('toggle-mic').setAttribute('aria-pressed', String(!!state.voice));
  $('toggle-camera').setAttribute('aria-pressed', String(!!state.camera));
  $('voice-input').disabled = !!state.voice;
}
function sendState(target) {
  if (!state.joined || !state.receiver) return;
  state.receiver.sendData({ scene: 1, mic: !!state.voice, camera: !!state.camera,
    role: state.room.role, movie: state.movie ? { title: state.movie.title, audio: state.movie.hasAudio } : null }, target);
}
function peerState(data) {
  if (!data || data.scene !== 1 || data.role === state.room?.role) return;
  state.lastSeen = Date.now();
  state.peer = true;
  connection('Together. Your movie night is connected.', true);
  $('remote-presence').textContent = data.mic ? 'Mic on' : 'Mic off';
  $('remote-avatar').hidden = !!data.camera && !!$('remote-camera').srcObject;
  $('remote-camera').hidden = !data.camera || !$('remote-camera').srcObject;
  if (state.room.role === 'guest') {
    if (data.movie && typeof data.movie.title === 'string') {
      $('movie-label').textContent = data.movie.title.slice(0, 160);
      $('source-caption').textContent = data.movie.audio ? 'Live from your host · movie sound included' : 'Live from your host · no movie-audio track';
    } else {
      $('remote-movie').hidden = true;
      $('stage-empty').hidden = false;
      $('movie-label').textContent = 'WAITING FOR THE OPENING SCENE';
      $('source-caption').textContent = 'Your host is choosing something good';
    }
  }
}

async function tryPlay(element) {
  if (!element.srcObject && !element.getAttribute('src')) return;
  try { await element.play(); }
  catch (error) {
    if (error.name === 'NotAllowedError') $('enable-sound').hidden = false;
  }
}
function receiveTrack({ streamID, track }) {
  if (!allowedStreams(state.room.role).includes(streamID) || streamID.endsWith('_control')) return;
  let stream = state.incoming.get(streamID);
  if (!stream) { stream = new MediaStream(); state.incoming.set(streamID, stream); }
  for (const old of stream.getTracks().filter(t => t.kind === track.kind && t.id !== track.id)) stream.removeTrack(old);
  if (!stream.getTrackById(track.id)) stream.addTrack(track);
  const element = streamID.endsWith('_voice') ? $('remote-voice') : streamID.endsWith('_camera') ? $('remote-camera') : $('remote-movie');
  element.srcObject = stream;
  if (streamID.endsWith('_camera')) {
    element.hidden = false;
    $('remote-avatar').hidden = true;
  } else if (streamID.endsWith('_movie') && track.kind === 'video') {
    element.hidden = false;
    $('stage-empty').hidden = true;
  }
  applyVolumes();
  void tryPlay(element);
}
function clearIncoming(sid) {
  state.incoming.delete(sid);
  const element = sid?.endsWith('_voice') ? $('remote-voice') : sid?.endsWith('_camera') ? $('remote-camera') : sid === 'host_movie' ? $('remote-movie') : null;
  if (element) { element.pause(); element.srcObject = null; }
  if (sid?.endsWith('_camera')) { $('remote-camera').hidden = true; $('remote-avatar').hidden = false; }
  if (sid === 'host_movie') { $('remote-movie').hidden = true; $('stage-empty').hidden = false; }
}
async function discover(detail) {
  if (!state.receiver || state.leaving) return;
  const receiver = state.receiver;
  for (const sid of discoverIds(detail)) {
    if (!allowedStreams(state.room.role).includes(sid) || state.views.has(sid)) continue;
    state.views.set(sid, true);
    try { await receiver.view(sid, { audio: sid.endsWith('_voice') || sid.endsWith('_movie'), video: sid.endsWith('_camera') || sid.endsWith('_movie'), downloads: false }); }
    catch (error) { state.views.delete(sid); if (state.joined) notice(`Could not receive a stream: ${friendlyError(error)}`, true); }
  }
}
function sdk() {
  if (typeof window.VDONinjaSDK !== 'function') throw new Error('The connection library could not load. Refresh this page.');
  const client = new window.VDONinjaSDK({ password: state.room.key, salt: 'same-scene-v1', debug: false,
    autoRecover: true, autoRelay: true, maxReconnectAttempts: 5 });
  state.clients.add(client);
  return client;
}
async function dispose(client) {
  if (!client) return;
  state.clients.delete(client);
  await client.disconnect().catch(() => {});
}
async function publish(stream, kind, media) {
  const client = sdk();
  try {
    await client.connect();
    if (state.leaving || !state.joined) throw new Error('The room was closed.');
    await client.joinRoom({ room: state.room.room });
    await client.publish(stream, { streamID: `${state.room.role}_${kind}`, label: `Same Scene ${kind}`, media });
    return client;
  } catch (error) { stopTracks(stream); await dispose(client); throw error; }
}

async function join(room) {
  if (state.joining || state.joined) return;
  state.joining = true;
  state.leaving = false;
  state.room = room;
  $('lobby').hidden = true;
  $('room').hidden = false;
  $('create-room').disabled = true;
  const host = room.role === 'host';
  $('copy-invite').hidden = !host;
  $('invite-card').hidden = !host;
  $('guest-card').hidden = host;
  $('host-tools').hidden = !host;
  $('choose-file').disabled = $('share-screen').disabled = true;
  $('remote-name').textContent = host ? 'Your person' : 'Your host';
  $('stage-description').textContent = host ? 'Choose a movie below. Your person gets the front-row seat.' : 'Your host will share the movie here. Settle in while they choose.';
  history.replaceState(null, '', roomLink(location.href, room, room.role));
  connection('Connecting to the room…');
  try {
    if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('Open this app over HTTPS or localhost to enable audio and video.');
    const receiver = sdk();
    state.receiver = receiver;
    receiver.addEventListener('track', ({ detail }) => { if (!state.leaving) receiveTrack(detail); });
    receiver.addEventListener('listing', ({ detail }) => void discover(detail));
    receiver.addEventListener('videoaddedtoroom', ({ detail }) => void discover(detail));
    receiver.addEventListener('dataReceived', ({ detail }) => peerState(detail.data));
    receiver.addEventListener('dataChannelOpen', () => sendState());
    receiver.addEventListener('peerDisconnected', ({ detail }) => {
      const sid = detail.streamID || detail.connection?.streamID;
      state.views.delete(sid);
      clearIncoming(sid);
    });
    receiver.addEventListener('disconnected', () => {
      if (state.joined && !state.leaving) connection('Connection interrupted. Trying to reconnect…');
    });
    receiver.addEventListener('reconnected', () => {
      if (!state.leaving) { state.views.clear(); connection('Reconnected. Waiting for your person…'); sendState(); }
    });
    await receiver.connect();
    await receiver.joinRoom({ room: room.room });
    await receiver.announce({ streamID: `${room.role}_control` });
    state.joined = true;
    // Room listings arrive before announce resolves. Revisit the SDK's known streams.
    await discover({ list: [...receiver.streams.keys()] });
    connection(host ? 'Room ready. Invite your person to join.' : 'Room ready. Waiting for your host…');
    $('toggle-mic').disabled = $('toggle-camera').disabled = false;
    $('choose-file').disabled = $('share-screen').disabled = false;
    state.heartbeat = setInterval(() => {
      sendState();
      if (state.lastSeen && Date.now() - state.lastSeen > 18000) {
        state.peer = false;
        connection('Your person is disconnected. Waiting for them to return…');
        $('remote-presence').textContent = 'Disconnected';
      }
      // Retry failed/stale subscriptions using current SDK discovery state.
      if (state.receiver && state.joined) void discover({ list: [...state.receiver.streams.keys()] });
    }, 5000);
    if (/Firefox\//.test(navigator.userAgent) && host) $('movie-audio-input').options[0].textContent = 'No screen audio — select BlackHole below';
    if (host && !navigator.mediaDevices.getDisplayMedia) {
      $('share-screen').disabled = true;
      notice('This browser cannot publish a screen. Use Firefox on your Mac to host.');
    }
    // Listing devices does not request access. Labels appear after explicit permission.
    void refreshDevices(false);
  } catch (error) {
    notice(friendlyError(error), true);
    await leave(false);
  } finally { state.joining = false; }
}

async function refreshDevices(requestPermission) {
  let permissionStream;
  try {
    if (requestPermission) permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const id of ['voice-input', 'movie-audio-input']) {
      const select = $(id), value = select.value;
      while (select.options.length > 1) select.remove(1);
      devices.filter(d => d.kind === 'audioinput').forEach((d, i) => select.add(new Option(d.label || `Audio input ${i + 1}`, d.deviceId)));
      if ([...select.options].some(o => o.value === value)) select.value = value;
    }
    if (requestPermission) {
      const bh = devices.find(d => d.kind === 'audioinput' && /blackhole/i.test(d.label));
      if (bh) { $('movie-audio-input').value = bh.deviceId; notice('BlackHole found. Route only your movie into it, then share a window.'); }
      else notice('Devices updated. BlackHole will appear here after it is installed.');
    }
  } catch (error) { if (requestPermission) notice(friendlyError(error), true); }
  finally { stopTracks(permissionStream); }
}

async function toggleVoice() {
  if (!state.joined) return;
  $('toggle-mic').disabled = true;
  try {
    if (state.voice) {
      const voice = state.voice; state.voice = null;
      stopTracks(voice.stream); await dispose(voice.client);
    } else {
      const input = $('voice-input');
      if (/blackhole|loopback/i.test(input.selectedOptions[0]?.textContent || '')) {
        throw new Error('Choose your real microphone for voice. BlackHole belongs in the movie-audio selector.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        ...(input.value ? { deviceId: { exact: input.value } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const client = await publish(stream, 'voice', { audio: { maxBitrate: 64000 } });
      if (state.leaving) { stopTracks(stream); await dispose(client); return; }
      state.voice = { stream, client };
      void refreshDevices(false);
    }
  } catch (error) { notice(friendlyError(error), true); }
  finally { setSelfStatus(); sendState(); $('toggle-mic').disabled = !state.joined; }
}
async function toggleCamera() {
  if (!state.joined) return;
  $('toggle-camera').disabled = true;
  try {
    if (state.camera) {
      const camera = state.camera; state.camera = null;
      stopTracks(camera.stream); await dispose(camera.client);
      $('local-camera').srcObject = null; $('local-camera').hidden = true; $('local-avatar').hidden = false;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 } }, audio: false });
      const client = await publish(stream, 'camera', { video: { maxBitrate: 500000 } });
      if (state.leaving) { stopTracks(stream); await dispose(client); return; }
      state.camera = { stream, client };
      $('local-camera').srcObject = stream; $('local-camera').hidden = false; $('local-avatar').hidden = true;
      await tryPlay($('local-camera'));
    }
  } catch (error) { notice(friendlyError(error), true); }
  finally { setSelfStatus(); sendState(); $('toggle-camera').disabled = !state.joined; }
}

function audioGraph() {
  if (!state.audioContext || state.audioContext.state === 'closed') {
    state.audioContext = new AudioContext();
    state.movieNode = state.audioContext.createMediaElementSource($('local-movie'));
    state.movieDestination = state.audioContext.createMediaStreamDestination();
    state.movieGain = state.audioContext.createGain();
    state.movieNode.connect(state.movieDestination);
    state.movieNode.connect(state.movieGain);
    state.movieGain.connect(state.audioContext.destination);
  }
  return state.audioContext;
}
function applyVolumes() {
  const film = Number($('movie-volume').value) / 100;
  $('remote-movie').volume = film;
  if (state.movieGain) state.movieGain.gain.value = film;
  if (state.movie?.monitor) state.movie.monitor.volume = film;
  $('remote-voice').volume = Number($('voice-volume').value) / 100;
  $('movie-volume-value').textContent = `${$('movie-volume').value}%`;
  $('voice-volume-value').textContent = `${$('voice-volume').value}%`;
}
function sharingUI(movie) {
  $('local-movie').hidden = movie?.kind !== 'file';
  $('screen-preview').hidden = movie?.kind !== 'screen';
  $('stage-empty').hidden = !!movie;
  $('sharing-badge').hidden = !movie;
  $('stop-sharing').hidden = !movie;
  $('movie-label').textContent = movie ? movie.title : 'WAITING FOR THE OPENING SCENE';
  $('source-caption').textContent = movie ? 'Live to your person · you control the movie' : 'Your own private little cinema';
  $('movie-audio-status').textContent = movie ? movie.hasAudio ? 'Movie picture and sound are being sent.' : 'Picture only. Stop and choose a movie-audio input to include sound.' : 'A local movie file is the simplest way to start.';
}
async function stopMovie() {
  const movie = state.movie; state.movie = null;
  if (!movie) return;
  clearInterval(movie.drawTimer);
  stopTracks(movie.stream);
  stopTracks(movie.captured);
  movie.monitor?.pause();
  if (movie.monitor) movie.monitor.srcObject = null;
  $('local-movie').pause();
  $('local-movie').removeAttribute('src');
  $('local-movie').load();
  $('screen-preview').srcObject = null;
  if (movie.objectURL) URL.revokeObjectURL(movie.objectURL);
  await dispose(movie.client);
  sharingUI(null);
  sendState();
}
function movieBusy(busy) {
  state.movieBusy = busy;
  $('choose-file').disabled = busy || !state.joined;
  $('share-screen').disabled = busy || !state.joined || !navigator.mediaDevices?.getDisplayMedia;
  $('stop-sharing').disabled = busy;
}
async function playFile(file) {
  if (!file || !state.joined || state.room.role !== 'host' || state.movieBusy) return;
  movieBusy(true);
  let movie;
  try {
    const context = audioGraph();
    await context.resume();
    await stopMovie();
    const video = $('local-movie');
    movie = { kind: 'file', title: file.name, hasAudio: true, objectURL: URL.createObjectURL(file) };
    video.src = movie.objectURL;
    video.volume = 1; video.muted = false;
    video.hidden = false;
    await new Promise((resolve, reject) => {
      const cleanup = () => { video.removeEventListener('loadedmetadata', done); video.removeEventListener('error', fail); clearTimeout(timer); };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('Firefox could not decode this movie. Try an MP4 (H.264/AAC), or play it in VLC and share its window with BlackHole audio.')); };
      const timer = setTimeout(fail, 20000);
      video.addEventListener('loadedmetadata', done, { once: true });
      video.addEventListener('error', fail, { once: true });
      if (video.readyState >= 1) done();
    });
    if (!video.videoWidth || !video.videoHeight) throw new Error('This file has no playable video track.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale / 2) * 2);
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale / 2) * 2);
    const drawContext = canvas.getContext('2d', { alpha: false });
    const draw = () => { if (video.readyState >= 2) drawContext.drawImage(video, 0, 0, canvas.width, canvas.height); };
    movie.drawTimer = setInterval(draw, 1000 / 30);
    const picture = canvas.captureStream(30);
    // Clone the graph's audio track: stopping this movie must not kill later files.
    const audio = state.movieDestination.stream.getAudioTracks()[0].clone();
    movie.stream = new MediaStream([...picture.getVideoTracks(), audio]);
    applyVolumes();
    await video.play();
    draw();
    movie.client = await publish(movie.stream, 'movie', { video: { maxBitrate: 3500000 }, audio: { maxBitrate: 128000 } });
    state.movie = movie;
    sharingUI(movie); applyVolumes(); sendState();
    notice('Movie ready. Play, pause, and seek using the player. Only you control it.');
  } catch (error) {
    if (movie) { clearInterval(movie.drawTimer); stopTracks(movie.stream); await dispose(movie.client); if (movie.objectURL) URL.revokeObjectURL(movie.objectURL); }
    $('local-movie').pause(); $('local-movie').removeAttribute('src'); $('local-movie').load();
    sharingUI(null); notice(friendlyError(error), true);
  } finally { movieBusy(false); $('movie-file').value = ''; }
}
async function shareScreen() {
  if (!state.joined || state.room.role !== 'host' || state.movieBusy) return;
  movieBusy(true);
  let movie;
  try {
    // Capture is invoked before an await to retain the click's user activation.
    const capturePromise = navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: true });
    const captured = await capturePromise;
    movie = { kind: 'screen', title: 'Shared movie window', captured };
    await stopMovie();
    let audioTracks = captured.getAudioTracks();
    const device = $('movie-audio-input').value;
    if (device) {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: device }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } }, video: false });
      captured.getAudioTracks().forEach(t => t.stop());
      audioTracks = audio.getAudioTracks();
      movie.monitor = new Audio();
      movie.monitor.srcObject = audio;
      movie.monitor.volume = Number($('movie-volume').value) / 100;
      await tryPlay(movie.monitor);
    }
    movie.stream = new MediaStream([...captured.getVideoTracks(), ...audioTracks]);
    movie.hasAudio = audioTracks.length > 0;
    movie.client = await publish(movie.stream, 'movie', { video: { maxBitrate: 3500000 }, audio: { maxBitrate: 128000 } });
    state.movie = movie;
    $('screen-preview').srcObject = captured;
    await tryPlay($('screen-preview'));
    captured.getVideoTracks()[0].addEventListener('ended', () => {
      if (state.movie === movie) void stopMovie();
    }, { once: true });
    sharingUI(movie); applyVolumes(); sendState();
    if (!movie.hasAudio) notice('Your screen is shared without movie sound. In Firefox, stop sharing, select BlackHole as movie audio, and share again.', true);
    else notice('Your movie window and audio are shared. Keep incoming call audio out of BlackHole.');
  } catch (error) {
    if (movie) { stopTracks(movie.captured); stopTracks(movie.stream); stopTracks(movie.monitor?.srcObject); movie.monitor?.pause(); await dispose(movie.client); }
    sharingUI(state.movie); notice(friendlyError(error), true);
  } finally { movieBusy(false); }
}

async function leave(clearURL = true) {
  if (state.leaving) return;
  state.leaving = true;
  state.joined = false;
  clearInterval(state.heartbeat);
  $('toggle-mic').disabled = $('toggle-camera').disabled = true;
  await stopMovie();
  stopTracks(state.voice?.stream); stopTracks(state.camera?.stream);
  state.voice = state.camera = null;
  await Promise.all([...state.clients].map(dispose));
  state.receiver = null; state.views.clear(); state.incoming.clear(); state.peer = false; state.lastSeen = 0;
  for (const id of ['remote-voice', 'remote-camera', 'remote-movie', 'local-camera']) { $(id).pause(); $(id).srcObject = null; }
  $('remote-camera').hidden = $('local-camera').hidden = $('remote-movie').hidden = true;
  $('remote-avatar').hidden = $('local-avatar').hidden = false;
  $('remote-presence').textContent = 'Waiting for them';
  $('lobby').hidden = false; $('room').hidden = true;
  $('create-room').disabled = false; setSelfStatus();
  if (clearURL) history.replaceState(null, '', location.pathname + location.search);
  state.leaving = false;
}
async function copyInvite() {
  const link = roomLink(location.href, state.room);
  try { await navigator.clipboard.writeText(link); notice('Invite copied. Send it to your person.'); }
  catch { $('invite-input').value = link; notice('Clipboard access was blocked. Your invite is available in the link box when you leave this room.', true); }
}

$('create-room').addEventListener('click', () => void join(createRoom()));
$('join-invite').addEventListener('click', () => {
  try {
    const value = $('invite-input').value.trim();
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Paste a valid movie-night invite link.');
    const invite = parseRoom(url.hash);
    if (!invite) throw new Error('This link does not include a room invite.');
    void join({ ...invite, role: 'guest' });
  } catch (error) { notice(friendlyError(error), true); }
});
$('accept-invite').addEventListener('click', () => { $('join-dialog').close(); void join(pendingInvite); });
$('join-dialog').addEventListener('cancel', event => { event.preventDefault(); $('join-dialog').close(); history.replaceState(null, '', location.pathname); });
for (const id of ['copy-invite', 'copy-invite-card']) $(id).addEventListener('click', () => void copyInvite());
$('leave-room').addEventListener('click', () => void leave());
$('toggle-mic').addEventListener('click', () => void toggleVoice());
$('toggle-camera').addEventListener('click', () => void toggleCamera());
$('choose-file').addEventListener('click', () => $('movie-file').click());
$('movie-file').addEventListener('change', event => void playFile(event.target.files[0]));
$('share-screen').addEventListener('click', () => void shareScreen());
$('stop-sharing').addEventListener('click', async () => { movieBusy(true); try { await stopMovie(); } finally { movieBusy(false); } });
$('refresh-devices').addEventListener('click', async () => { $('refresh-devices').disabled = true; await refreshDevices(true); $('refresh-devices').disabled = false; });
for (const id of ['movie-volume', 'voice-volume']) $(id).addEventListener('input', applyVolumes);
$('enable-sound').addEventListener('click', async () => {
  await state.audioContext?.resume();
  const elements = [$('remote-movie'), $('remote-voice'), state.movie?.monitor].filter(Boolean).filter(e => e.srcObject);
  try { await Promise.all(elements.map(e => e.play())); $('enable-sound').hidden = true; }
  catch { notice('Playback is still blocked. Tap again and check your browser’s autoplay permissions.', true); }
});
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('stage').requestFullscreen();
  } catch { notice('Fullscreen is unavailable in this browser. Try rotating your device to landscape.'); }
});
for (const id of ['help-open', 'audio-help']) $(id).addEventListener('click', showHelp);
$('help-close').addEventListener('click', () => $('help-dialog').close());
$('notice-dismiss').addEventListener('click', () => { $('notice').hidden = true; });
window.addEventListener('pagehide', () => {
  clearInterval(state.heartbeat);
  for (const capture of [state.voice, state.camera, state.movie]) stopTracks(capture?.stream);
  stopTracks(state.movie?.captured);
  for (const client of state.clients) void client.disconnect();
});

try {
  pendingInvite = parseRoom(location.hash);
  if (pendingInvite) {
    $('join-dialog').querySelector('h2').innerHTML = pendingInvite.role === 'host' ? 'Welcome back.<br><em>Your room awaits.</em>' : 'Make yourself<br><em>at home.</em>';
    if (pendingInvite.role === 'host') $('join-dialog').querySelector('p:not(.eyebrow)').textContent = 'Re-open your room to share a movie. Your microphone and camera start off.';
    $('join-dialog').showModal();
  }
} catch (error) { notice(friendlyError(error), true); }
