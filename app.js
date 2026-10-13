import { createRoom, parseRoom, roomLink, allowedStreams, discoverIds, friendlyError, loadSavedRoom, saveRoom, loadHostSettings, saveHostSettings } from './core.js';

const $ = id => document.getElementById(id);
const state = {
  room: null, receiver: null, clients: new Set(), joined: false, joining: false, leaving: false,
  views: new Map(), incoming: new Map(), voice: null, camera: null, movie: null,
  heartbeat: null, lastSeen: 0, peer: false, movieBusy: false, audioContext: null,
  movieNode: null, movieDestination: null, movieGain: null, sendGain: null, sendLimiter: null,
  output: null, movieMuted: false, deafened: false,
};
let pendingInvite = null;
let hostDefaults = null;
try { hostDefaults = loadHostSettings(localStorage); } catch {}
function savedDevice(id) { const select = $(id); return { id: select.value, label: select.selectedOptions[0]?.textContent || '' }; }
function persistHostDefaults(showMessage = false) {
  if (state.room?.role !== 'host') return;
  const settings = { ...hostDefaults, voice: savedDevice('voice-input'), camera: savedDevice('camera-input'), movie: savedDevice('movie-audio-input'),
    boost: Number($('send-boost').value), movieVolume: Number($('movie-volume').value), voiceVolume: Number($('voice-volume').value), monitor: $('monitor-movie').checked, processing: $('voice-processing').checked };
  if (state.output) settings.output = { id: state.output.deviceId, label: state.output.label };
  let saved = false;
  try { saved = saveHostSettings(localStorage, settings); } catch {}
  if (saved) hostDefaults = settings;
  $('host-defaults-status').textContent = saved ? 'Host defaults saved in this browser. Device access and screen sharing still need permission.' : 'Browser storage is blocked. Your choices could not be saved.';
  if (showMessage) notice(saved ? 'Host defaults saved: movie input, microphone, camera, headphones and loudness.' : 'Host defaults could not be saved. Allow site storage in Firefox.', !saved);
}
function applyHostDefaults() {
  if (state.room?.role !== 'host' || !hostDefaults) return;
  for (const [id, name] of [['send-boost', 'boost'], ['movie-volume', 'movieVolume'], ['voice-volume', 'voiceVolume']]) if (hostDefaults[name] !== undefined) $(id).value = hostDefaults[name];
  for (const [id, name] of [['monitor-movie', 'monitor'], ['voice-processing', 'processing']]) if (hostDefaults[name] !== undefined) $(id).checked = hostDefaults[name];
  $('host-defaults-status').textContent = 'Saved host defaults loaded. Screen sharing starts only when you choose a window.';
  applyVolumes();
}
async function setOutput(device) {
  if (!device.deviceId || device.deviceId === 'default' || /blackhole|multi.?output|system default|same scene movie/i.test(device.label)) throw new Error('Choose physical headphones or speakers for call sound.');
  await $('remote-voice').setSinkId(device.deviceId);
  await $('remote-movie').setSinkId(device.deviceId);
  if (state.movie?.monitor) await state.movie.monitor.setSinkId(device.deviceId);
  state.output = device;
  $('output-label').textContent = device.label || 'Selected physical output';
}
async function restoreHostOutput() {
  if (state.room?.role !== 'host' || !hostDefaults?.output || !$('remote-voice').setSinkId) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const saved = hostDefaults.output;
    const device = devices.find(d => d.kind === 'audiooutput' && d.deviceId === saved.id) || devices.find(d => d.kind === 'audiooutput' && d.label === saved.label);
    if (!device) throw new Error('Saved headphones are unavailable');
    await setOutput(device);
  } catch { state.output = null; $('output-label').textContent = 'Saved headphones need access — click Choose headphones'; }
}

let savedHost = null, savedGuest = null;
function readSavedRooms() {
  try {
    savedHost = loadSavedRoom(localStorage, 'host');
    savedGuest = loadSavedRoom(localStorage, 'guest');
  } catch { savedHost = savedGuest = null; }
  $('saved-rooms').hidden = !savedHost && !savedGuest;
  $('saved-host').hidden = !savedHost;
  $('saved-guest').hidden = !savedGuest;
  $('create-room').textContent = savedHost ? 'Open your watch room →' : 'Start a movie night ↗';
}
function rememberRoom(room) {
  let saved = false;
  try { saved = saveRoom(localStorage, room); } catch { /* Bookmarks still work with blocked storage. */ }
  readSavedRooms();
  if (!saved) notice('This browser cannot save your room. Bookmark this page or copy your link to return next time.');
}


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
  $('voice-processing').disabled = !!state.voice;
  $('camera-input').disabled = !!state.camera;
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
async function chooseOutput() {
  try {
    if (!navigator.mediaDevices?.selectAudioOutput || !$('remote-voice').setSinkId) {
      throw new Error('This browser cannot choose call output. Use current Firefox on your Mac, or keep system output on headphones and route only the movie player into BlackHole.');
    }
    const device = await navigator.mediaDevices.selectAudioOutput(state.room?.role === 'host' && hostDefaults?.output ? { deviceId: hostDefaults.output.id } : {});
    if (!device.deviceId || device.deviceId === 'default' || /blackhole|multi.?output|system default|same scene movie/i.test(device.label)) {
      throw new Error('Choose physical headphones or speakers. System default, BlackHole and Multi-Output would send the call back into the movie.');
    }
    await setOutput(device);
    $('remote-voice').muted = false;
    persistHostDefaults();
    notice('Call audio goes directly to your selected headphones. Movie audio can now go into BlackHole separately.');
  } catch (error) { notice(friendlyError(error), true); }
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
  $('room').dataset.role = room.role;
  $('role-label').textContent = host ? 'HOST ROOM' : 'GUEST ROOM';
  $('room-title').textContent = host ? 'Your watch room' : 'Watching together';
  $('playback-hint').textContent = host ? 'You control playback in the movie window.' : 'Your host controls playback. Sound settings affect only you.';
  $('pip').hidden = !document.pictureInPictureEnabled;
  $('choose-output').hidden = !navigator.mediaDevices?.selectAudioOutput || !$('remote-voice').setSinkId;
  $('output-label').textContent = state.output?.label || 'System default';
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
    rememberRoom(room);
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
    applyHostDefaults();
    await refreshDevices(false);
    await restoreHostOutput();
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
    for (const id of ['voice-input', 'movie-audio-input', 'camera-input']) {
      const select = $(id), value = select.value;
      while (select.options.length > 1) select.remove(1);
      devices.filter(d => d.kind === (id === 'camera-input' ? 'videoinput' : 'audioinput')).forEach((d, i) => select.add(new Option(d.label || `${id === 'camera-input' ? 'Camera' : 'Audio input'} ${i + 1}`, d.deviceId)));
      const preferred = state.room?.role === 'host' ? hostDefaults?.[id === 'voice-input' ? 'voice' : id === 'camera-input' ? 'camera' : 'movie'] : null;
      const choice = [...select.options].find(o => preferred?.id && o.value === preferred.id) || [...select.options].find(o => preferred?.label && o.textContent === preferred.label && o.value);
      if (choice) select.value = choice.value;
      else if ([...select.options].some(o => o.value === value)) select.value = value;
      if (state.room?.role === 'host' && id === 'movie-audio-input' && !select.value && !preferred?.id) {
        const blackhole = [...select.options].find(o => /blackhole/i.test(o.textContent));
        if (blackhole) select.value = blackhole.value;
      }
    }
    if (requestPermission) {
      const bh = devices.find(d => d.kind === 'audioinput' && /blackhole/i.test(d.label));
      if (bh && state.room?.role === 'host' && !hostDefaults?.movie?.id) { $('movie-audio-input').value = bh.deviceId; notice('BlackHole found. Route only your movie into it, then share a window.'); }
      else notice(state.room?.role === 'host' ? 'Devices updated. BlackHole will appear here after it is installed.' : 'Microphone and camera devices updated.');
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
        ...(input.value ? { deviceId: { exact: input.value } } : {}), echoCancellation: $('voice-processing').checked, noiseSuppression: $('voice-processing').checked, autoGainControl: $('voice-processing').checked }, video: false });
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
      const stream = await navigator.mediaDevices.getUserMedia({ video: { ...($('camera-input').value ? { deviceId: { exact: $('camera-input').value } } : {}), width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 } }, audio: false });
      const client = await publish(stream, 'camera', { video: { maxBitrate: 500000 } });
      if (state.leaving) { stopTracks(stream); await dispose(client); return; }
      state.camera = { stream, client };
      $('local-camera').srcObject = stream; $('local-camera').hidden = false; $('local-avatar').hidden = true;
      await tryPlay($('local-camera'));
    }
  } catch (error) { notice(friendlyError(error), true); }
  finally { setSelfStatus(); sendState(); $('toggle-camera').disabled = !state.joined; }
}

function limiter(context) {
  const node = context.createDynamicsCompressor();
  node.threshold.value = -3; node.knee.value = 0; node.ratio.value = 20; node.attack.value = 0.003; node.release.value = 0.15;
  return node;
}
function watchMovieSignal(movie, source, context) {
  const analyzer = context.createAnalyser(); analyzer.fftSize = 2048;
  source.connect(analyzer);
  movie.analyzer = analyzer;
  movie.signalSource = source;
  const samples = new Float32Array(analyzer.fftSize);
  movie.levelTimer = setInterval(() => {
    if (state.movie !== movie) return;
    analyzer.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
    const level = rms > 0 ? Math.max(0, Math.min(100, (20 * Math.log10(rms) + 60) / 60 * 100)) : 0;
    $('movie-signal').value = level;
    $('movie-signal-label').textContent = rms > 0.0001 ? 'Movie audio detected · being sent' : movie.kind === 'file' ? 'Movie audio quiet or paused' : 'No movie sound detected — check playback and Mac output';
  }, 250);
}
function audioGraph() {
  if (!state.audioContext || state.audioContext.state === 'closed') {
    state.audioContext = new AudioContext();
    state.movieNode = state.audioContext.createMediaElementSource($('local-movie'));
    state.movieDestination = state.audioContext.createMediaStreamDestination();
    state.movieGain = state.audioContext.createGain();
    state.sendGain = state.audioContext.createGain();
    state.sendLimiter = limiter(state.audioContext);
    state.movieNode.connect(state.sendGain).connect(state.sendLimiter).connect(state.movieDestination);
    state.movieNode.connect(state.movieGain);
    state.movieGain.connect(state.audioContext.destination);
  }
  return state.audioContext;
}
function applyVolumes() {
  const boost = Number($('send-boost').value) / 100;
  if (state.sendGain) state.sendGain.gain.value = boost;
  if (state.movie?.sendGain) state.movie.sendGain.gain.value = boost;
  $('send-boost-value').textContent = `${$('send-boost').value}%`;
  const externalAudio = state.room?.role === 'host' && state.movie?.kind === 'screen' && !$('monitor-movie').checked;
  $('movie-volume').disabled = $('mute-movie').disabled = !!externalAudio;
  $('movie-volume').title = externalAudio ? 'Change movie volume in the shared movie window.' : 'Movie volume for you';
  if (state.room?.role === 'host') $('playback-hint').textContent = externalAudio ? 'Change playback and movie volume in the shared window.' : state.movie?.kind === 'file' ? 'Use the player to pause or seek. Volume changes only what you hear.' : 'You control playback in the movie window.';
  const film = state.movieMuted || (state.deafened && state.room?.role === 'guest') ? 0 : Number($('movie-volume').value) / 100;
  $('remote-movie').volume = film;
  if (state.movieGain) state.movieGain.gain.value = film;
  if (state.movie?.monitor) state.movie.monitor.volume = $('monitor-movie').checked ? film : 0;
  $('remote-voice').volume = state.deafened ? 0 : Number($('voice-volume').value) / 100;
  $('mute-movie').setAttribute('aria-pressed', String(state.movieMuted));
  $('mute-movie-label').textContent = state.movieMuted ? 'Movie muted' : 'Movie sound';
  $('deafen').setAttribute('aria-pressed', String(state.deafened));
  $('deafen').textContent = state.deafened ? 'Unmute incoming sound' : 'Mute incoming sound';
  $('movie-volume-value').textContent = `${$('movie-volume').value}%`;
  $('fullscreen-voice-volume').value = $('voice-volume').value;
  $('voice-volume-value').textContent = `${$('voice-volume').value}%`;
}
function sharingUI(movie) {
  applyVolumes();
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
  clearInterval(movie.levelTimer);
  if (movie.analyzer) { try { movie.signalSource?.disconnect(movie.analyzer); } catch {} }
  movie.analyzer?.disconnect();
  movie.source?.disconnect();
  movie.sendGain?.disconnect();
  movie.sendLimiter?.disconnect();
  $('movie-signal').value = 0;
  $('movie-signal-label').textContent = 'Start sharing to check movie sound';
  stopTracks(movie.stream);
  stopTracks(movie.captured);
  stopTracks(movie.rawAudio);
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
    watchMovieSignal(movie, state.sendLimiter, context);
    sharingUI(movie); applyVolumes(); sendState();
    notice('Movie ready. Play, pause, and seek using the player. Only you control it.');
  } catch (error) {
    if (movie) { clearInterval(movie.levelTimer); if (movie.analyzer) { try { movie.signalSource?.disconnect(movie.analyzer); } catch {} } clearInterval(movie.drawTimer); stopTracks(movie.stream); await dispose(movie.client); if (movie.objectURL) URL.revokeObjectURL(movie.objectURL); }
    $('local-movie').pause(); $('local-movie').removeAttribute('src'); $('local-movie').load();
    sharingUI(null); notice(friendlyError(error), true);
  } finally { movieBusy(false); $('movie-file').value = ''; }
}
async function shareScreen() {
  if (!state.joined || state.room.role !== 'host' || state.movieBusy) return;
  movieBusy(true);
  let movie;
  try {
    const selected = $('movie-audio-input').selectedOptions[0]?.textContent || '';
    if (/Firefox\//.test(navigator.userAgent) && $('movie-audio-input').value && /blackhole/i.test(selected) && !state.output) {
      throw new Error('First choose your physical headphones under Call audio output. This keeps your guest’s voice out of BlackHole.');
    }
    // Resume audio and invoke capture within the share button's user activation.
    const context = audioGraph();
    const audioReady = context.resume();
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
      movie.monitor.volume = $('monitor-movie').checked ? Number($('movie-volume').value) / 100 : 0;
      if (state.output && movie.monitor.setSinkId) await movie.monitor.setSinkId(state.output.deviceId);
      await tryPlay(movie.monitor);
    }
    if (audioTracks.length) {
      await audioReady;
      movie.source = context.createMediaStreamSource(new MediaStream(audioTracks));
      movie.sendGain = context.createGain(); movie.sendGain.gain.value = Number($('send-boost').value) / 100;
      movie.sendLimiter = limiter(context);
      const destination = context.createMediaStreamDestination();
      movie.source.connect(movie.sendGain).connect(movie.sendLimiter).connect(destination);
      movie.rawAudio = new MediaStream(audioTracks);
      audioTracks = destination.stream.getAudioTracks();
      watchMovieSignal(movie, movie.sendLimiter, context);
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
    if (movie) { clearInterval(movie.levelTimer); movie.source?.disconnect(); movie.sendGain?.disconnect(); movie.sendLimiter?.disconnect(); stopTracks(movie.rawAudio); stopTracks(movie.captured); stopTracks(movie.stream); stopTracks(movie.monitor?.srcObject); movie.monitor?.pause(); await dispose(movie.client); }
    sharingUI(state.movie); notice(friendlyError(error), true);
  } finally { movieBusy(false); }
}

async function leave(clearURL = true) {
  if (state.leaving) return;
  state.leaving = true;
  if (playerFullscreen()) { try { await document.exitFullscreen(); } catch {} }
  clearTimeout(controlsTimer);
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
async function copyInvite(room = state.room, role = 'guest') {
  const link = roomLink(location.href, room, role);
  try { await navigator.clipboard.writeText(link); notice(role === 'host' ? 'Your host link is copied. Save it for yourself to reopen this room.' : 'Permanent guest invite copied. Share it once and reuse it every movie night.'); }
  catch { $('invite-input').value = link; notice('Clipboard access was blocked. Your invite is available in the link box when you leave this room.', true); }
}

$('create-room').addEventListener('click', () => void join(savedHost || createRoom()));
$('create-new-room').addEventListener('click', () => void join(createRoom()));
$('resume-host').addEventListener('click', () => { if (savedHost) void join(savedHost); });
$('resume-guest').addEventListener('click', () => { if (savedGuest) void join(savedGuest); });
$('copy-saved-invite').addEventListener('click', () => { if (savedHost) void copyInvite(savedHost); });
$('copy-host-link').addEventListener('click', () => void copyInvite(state.room, 'host'));
window.addEventListener('storage', readSavedRooms);
readSavedRooms();
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
for (const id of ['movie-volume', 'voice-volume', 'send-boost']) $(id).addEventListener('input', () => { applyVolumes(); persistHostDefaults(); });
for (const id of ['voice-input', 'camera-input', 'movie-audio-input', 'voice-processing', 'monitor-movie']) $(id).addEventListener('change', () => persistHostDefaults());
$('save-host-defaults').addEventListener('click', () => persistHostDefaults(true));
$('mute-movie').addEventListener('click', () => { state.movieMuted = !state.movieMuted; applyVolumes(); });
$('deafen').addEventListener('click', () => { state.deafened = !state.deafened; applyVolumes(); });
$('theater').addEventListener('click', () => { const wide = $('room').classList.toggle('theater'); $('theater').setAttribute('aria-pressed', String(wide)); });
$('pip').addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else { const video = [$('local-movie'), $('screen-preview'), $('remote-movie')].find(v => !v.hidden && v.readyState >= 2);
      if (!video) throw new Error('Start a movie before opening the floating player.');
      await video.requestPictureInPicture(); }
  } catch (error) { notice(friendlyError(error), true); }
});
$('refresh-call-devices').addEventListener('click', async () => { $('refresh-call-devices').disabled = true; await refreshDevices(true); $('refresh-call-devices').disabled = false; });
$('monitor-movie').addEventListener('change', applyVolumes);
$('choose-output').addEventListener('click', () => void chooseOutput());
$('enable-sound').addEventListener('click', async () => {
  await state.audioContext?.resume();
  const elements = [$('remote-movie'), $('remote-voice'), state.movie?.monitor].filter(Boolean).filter(e => e.srcObject);
  try { await Promise.all(elements.map(e => e.play())); $('enable-sound').hidden = true; }
  catch { notice('Playback is still blocked. Tap again and check your browser’s autoplay permissions.', true); }
});
// Fullscreen the whole player so sound controls remain available over the movie.
const player = $('movie-player');
let controlsTimer, keyboardControls = false, draggingControl = false, orientationRequested = false;
function playerFullscreen() { return document.fullscreenElement === player; }
function revealPlayerControls() {
  clearTimeout(controlsTimer);
  player.classList.remove('controls-idle');
  if (!playerFullscreen()) return;
  controlsTimer = setTimeout(() => {
    if (draggingControl || (keyboardControls && $('player-controls').contains(document.activeElement)) || !$('enable-sound').hidden) return;
    player.classList.add('controls-idle');
  }, 3000);
}
async function toggleFullscreen() {
  try {
    if (playerFullscreen()) { await document.exitFullscreen(); return; }
    $('fullscreen-tip').hidden = true;
    await player.requestFullscreen({ navigationUI: 'hide' });
    if (navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) <= 1024 && playerFullscreen()) {
      try {
        if (!screen.orientation?.lock) throw new Error('Orientation lock unavailable');
        orientationRequested = true;
        await screen.orientation.lock('landscape');
        if (!playerFullscreen()) screen.orientation.unlock();
      } catch {
        if (playerFullscreen()) {
          $('fullscreen-tip').textContent = 'Rotate your phone to landscape if it does not turn automatically.';
          $('fullscreen-tip').hidden = false;
        }
      }
    }
  } catch { notice('Fullscreen is unavailable in this browser. Try rotating your device to landscape.'); }
}
$('fullscreen').addEventListener('click', event => {
  keyboardControls = event.detail === 0;
  if (!keyboardControls) $('fullscreen').blur();
  void toggleFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  const active = playerFullscreen();
  player.classList.toggle('is-fullscreen', active);
  $('fullscreen').setAttribute('aria-pressed', String(active));
  $('fullscreen').setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  $('fullscreen-label').textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  $('fullscreen').title = active ? 'Exit fullscreen (F or Esc)' : 'Fullscreen (F)';
  if (!active) $('fullscreen-tip').hidden = true;
  if (!active && orientationRequested) {
    try { screen.orientation?.unlock(); } catch { /* The browser may already unlock on exit. */ }
    orientationRequested = false;
  }
  revealPlayerControls();
});
player.addEventListener('pointermove', () => { keyboardControls = false; revealPlayerControls(); });
player.addEventListener('pointerdown', event => {
  keyboardControls = false;
  draggingControl = $('player-controls').contains(event.target);
  revealPlayerControls();
});
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => {
  if (draggingControl) { draggingControl = false; revealPlayerControls(); }
});
player.addEventListener('focusin', revealPlayerControls);
player.addEventListener('dblclick', event => {
  if (event.target.closest('button, input, .player-controls') || event.target === $('local-movie')) return;
  void toggleFullscreen();
});
player.addEventListener('keydown', event => {
  keyboardControls = true;
  revealPlayerControls();
  if (event.target.closest('input, select, button') || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); void toggleFullscreen(); }
  if (event.key.toLowerCase() === 'm') { event.preventDefault(); if (!$('mute-movie').disabled) $('mute-movie').click(); }
  if (['ArrowUp', 'ArrowDown'].includes(event.key) && !$('movie-volume').disabled) {
    event.preventDefault();
    $('movie-volume').value = Math.max(0, Math.min(100, Number($('movie-volume').value) + (event.key === 'ArrowUp' ? 5 : -5)));
    applyVolumes();
  }
});
$('fullscreen-voice-volume').addEventListener('input', () => {
  $('voice-volume').value = $('fullscreen-voice-volume').value;
  applyVolumes();
});
for (const id of ['help-open', 'audio-help']) $(id).addEventListener('click', showHelp);
$('help-close').addEventListener('click', () => $('help-dialog').close());
$('notice-dismiss').addEventListener('click', () => { $('notice').hidden = true; });
window.addEventListener('pagehide', () => {
  clearInterval(state.heartbeat);
  for (const capture of [state.voice, state.camera, state.movie]) stopTracks(capture?.stream);
  stopTracks(state.movie?.captured);
  stopTracks(state.movie?.rawAudio);
  clearInterval(state.movie?.levelTimer);
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
