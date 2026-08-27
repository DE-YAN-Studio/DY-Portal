import config from './config.js';

const params = new URLSearchParams(window.location.search);
const LOCAL_ID = params.get('local') || config.LOCAL_PEER_ID;
const REMOTE_ID = params.get('remote') || config.REMOTE_PEER_ID;

let peer = null;
let localStream = null;
let currentCall = null;
let dataConn = null;
let isMuted = getCookie('muted') === 'true';
let isCameraHidden = getCookie('cameraHidden') === 'true';
let currentFacingMode = 'user';
let availableCameras = [];
let localVideoRotation = 0;
let hideControlsTimeout = null;

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? match[2] : null;
}

function setCookie(name, value) {
  document.cookie = `${name}=${value}; max-age=${60*60*24*365}; path=/`;
}

// Show office selection or portal based on URL params
document.addEventListener('DOMContentLoaded', () => {
  const hasUrlParams = params.has('local') && params.has('remote');
  if (hasUrlParams) {
    document.getElementById('office-select').classList.add('hidden');
    document.getElementById('portal').classList.remove('hidden');
    applyInitialSettings();
    init();
    setupMouseTracking();
  }
});

function setupMouseTracking() {
  const controls = document.getElementById('controls');
  const status = document.getElementById('status');

  function showUI() {
    controls.classList.add('visible');
    status.classList.add('visible');
    document.body.style.cursor = 'default';

    if (hideControlsTimeout) {
      clearTimeout(hideControlsTimeout);
    }

    hideControlsTimeout = setTimeout(() => {
      controls.classList.remove('visible');
      status.classList.remove('visible');
      document.body.style.cursor = 'none';
    }, 3000);
  }

  document.addEventListener('mousemove', showUI);
  document.addEventListener('click', showUI);
  document.addEventListener('touchstart', showUI);

  // Show initially
  showUI();
}

async function init() {
  updateStatus('Initializing...');
  await enumerateCameras();
  try {
    await getLocalStream();
    connectToPeerServer();
  } catch (err) {
    handleCameraError(err);
  }
}

async function enumerateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    availableCameras = devices.filter(d => d.kind === 'videoinput');
    console.log('Available cameras:', availableCameras.length);
  } catch (err) {
    console.error('Could not enumerate devices:', err);
  }
}

async function getLocalStream(facingMode = 'user') {
  updateStatus('Requesting camera/microphone access...');

  const constraints = {
    video: {
      ...config.VIDEO_CONSTRAINTS,
      facingMode: facingMode
    },
    audio: config.AUDIO_CONSTRAINTS
  };

  try {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }

    localStream = await navigator.mediaDevices.getUserMedia(constraints);

    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    await localVideo.play();

    if (isMuted) {
      localStream.getAudioTracks().forEach(track => track.enabled = false);
    }
    if (isCameraHidden) {
      localStream.getVideoTracks().forEach(track => track.enabled = false);
    }

    document.getElementById('camera-error').classList.add('hidden');
    updateStatus('Local stream ready');
    currentFacingMode = facingMode;

    return localStream;
  } catch (err) {
    console.error(`getUserMedia error: ${err.name}: ${err.message}`);
    throw err;
  }
}

function handleCameraError(err) {
  console.error(`Camera error: ${err.name}: ${err.message}`);
  const errorEl = document.getElementById('camera-error');
  const messageEl = document.getElementById('error-message');

  let message = 'Unable to access camera or microphone.';

  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    message = 'Camera/microphone access was denied. Please allow access in your browser settings and try again.';
  } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
    message = 'No camera or microphone found. Please connect a device and try again.';
  } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
    message = 'Camera is in use by another application. Please close other apps using the camera.';
  } else if (err.name === 'OverconstrainedError') {
    message = 'Camera does not support the requested settings. Trying with default settings...';
  } else if (err.name === 'TypeError') {
    message = 'No camera constraints specified.';
  }

  messageEl.textContent = message;
  errorEl.classList.remove('hidden');
  updateStatus('Camera error');
}

window.retryCamera = async function() {
  document.getElementById('camera-error').classList.add('hidden');
  try {
    await getLocalStream();
    connectToPeerServer();
  } catch (err) {
    handleCameraError(err);
  }
};

window.continueWithoutCamera = function() {
  document.getElementById('camera-error').classList.add('hidden');
  localStream = null;
  connectToPeerServer();
  updateStatus('Connected without camera');
};

// PeerJS falls back to its own hardcoded ICE servers when it is given none,
// and those hosts stopped resolving - which presents as a perfectly healthy
// signaling connection carrying no video. The server owns the list instead, so
// TURN credentials stay in one place and can rotate without touching a display.
async function fetchIceServers() {
  try {
    // `redirect: 'error'` rather than the default 'follow'. /api/ice sits behind
    // requireAuth, which redirects to /login rather than returning 401, so a
    // followed redirect arrives as a 200 carrying the login page - response.ok
    // is true, and the failure only surfaces as a JSON parse error blamed on
    // the wrong thing. An expired session would quietly cost the portal its
    // relay, which is the exact shape of outage this endpoint exists to prevent.
    const response = await fetch('/api/ice', {
      credentials: 'same-origin',
      redirect: 'error'
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      throw new Error(`expected JSON, got ${type || 'no content-type'}`);
    }

    const body = await response.json();
    if (!Array.isArray(body.iceServers) || body.iceServers.length === 0) {
      throw new Error('none configured');
    }

    return body.iceServers;
  } catch (err) {
    // Loud on purpose. The fallback is STUN-only, which cannot carry this
    // portal - the two offices have no direct path - so this line is the
    // difference between a five-minute diagnosis and a long one.
    console.error(
      `Could not fetch ICE servers: ${err.message}. ` +
      'Falling back to STUN only - if the offices need a relay there will be NO VIDEO. ' +
      'A redirect or non-JSON response here means the session is not authenticated.'
    );
    return config.ICE_SERVERS_FALLBACK;
  }
}

let connecting = false;

// Both ends used to call each other and both answered, so every connection
// produced two PeerConnections; `currentCall` kept only the newest and the
// other was never closed. Each orphan holds its ICE sockets for the life of the
// page, so on an always-on display they accumulate until the renderer cannot
// allocate a UDP port at all - at which point ICE gathers no candidates, no
// media flows, and signaling still looks perfectly healthy.
//
// One deterministic caller fixes the duplication: the lexicographically smaller
// ID dials, the other only answers. Both ends agree without negotiating.
const IS_CALLER = LOCAL_ID < REMOTE_ID;

// Replacing a call must close the one it supersedes, or it leaks exactly as
// before. Guarded against re-entry because close() fires the 'close' handler.
function setCurrentCall(call) {
  const previous = currentCall;
  currentCall = call;

  if (previous && previous !== call) {
    console.log('Closing superseded call');
    try {
      previous.close();
    } catch (err) {
      console.error('Could not close superseded call:', err.message);
    }
  }
}

// A call that is no longer the active one closing is expected - it must not
// drag the live connection down with it by triggering a reconnect.
function handleCallClosed(call, reason) {
  if (call !== currentCall) {
    console.log(`Ignoring ${reason} on a stale call`);
    return;
  }

  currentCall = null;
  updateStatus(`${reason}, reconnecting...`);
  showOfflineOverlay();
  scheduleReconnect();
}

function isCallLive(call) {
  return Boolean(call && call.peerConnection &&
    !['closed', 'failed', 'disconnected'].includes(call.peerConnection.connectionState));
}

async function connectToPeerServer() {
  // Fetching the ICE config yields to the network. Without this guard a
  // reconnect firing during that window would build a second Peer on the same
  // ID, and the two would take turns evicting each other.
  if (connecting) return;
  connecting = true;

  updateStatus('Connecting to signaling server...');

  // Refetched per connection rather than cached, because TURN credentials from
  // a managed provider are typically short-lived.
  const iceServers = await fetchIceServers();
  console.log(`ICE servers: ${iceServers.map((s) => s.urls).join(', ')}`);

  peer = new Peer(LOCAL_ID, {
    host: config.PEER_SERVER_HOST,
    port: config.PEER_SERVER_PORT,
    path: config.PEER_SERVER_PATH,
    secure: config.PEER_SERVER_SECURE,
    config: { iceServers }
  });

  connecting = false;

  peer.on('open', (id) => {
    console.log(`Connected to peer server with ID: ${id} (role: ${IS_CALLER ? 'caller' : 'answerer'})`);
    updateStatus(`Connected as ${id}`);
    // Only the caller opens the data channel too, for the same reason.
    if (IS_CALLER) {
      connectData();
      callRemote();
    } else {
      updateStatus(`Connected as ${id}, waiting for ${REMOTE_ID}`);
    }
  });

  peer.on('connection', (conn) => {
    console.log('Incoming data connection from:', conn.peer);
    setupDataConnection(conn);
  });

  peer.on('call', (call) => {
    console.log('Incoming call from:', call.peer);
    updateStatus(`Incoming call from ${call.peer}`);
    call.answer(localStream);

    call.on('stream', (stream) => {
      handleRemoteStream(stream);
    });

    call.on('close', () => handleCallClosed(call, 'Call closed'));

    call.on('error', (err) => {
      console.error('Call error:', err);
      updateStatus(`Call error: ${err.message}`);
      handleCallClosed(call, 'Call error');
    });

    setCurrentCall(call);
  });

  peer.on('disconnected', () => {
    console.log('Disconnected from peer server, attempting reconnect...');
    setSignalingStatus('Disconnected, reconnecting...');
    showOfflineIfNoMedia('Signaling disconnected');
    setTimeout(() => {
      if (peer && !peer.destroyed) {
        peer.reconnect();
      } else {
        connectToPeerServer();
      }
    }, 1000);
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    setSignalingStatus(`Error: ${err.type}`);
    showOfflineIfNoMedia(`Peer error ${err.type}`);

    if (err.type === 'unavailable-id') {
      console.log('ID taken, retrying with delay...');
      setTimeout(() => connectToPeerServer(), 5000);
    } else if (err.type === 'peer-unavailable') {
      scheduleReconnect();
    } else if (err.type === 'network' || err.type === 'server-error') {
      scheduleReconnect();
    } else {
      scheduleReconnect();
    }
  });

  peer.on('close', () => {
    console.log('Peer connection closed');
    setSignalingStatus('Connection closed');
    showOfflineIfNoMedia('Signaling closed');
    scheduleReconnect();
  });
}

function callRemote() {
  if (!peer || !REMOTE_ID) {
    console.log('Cannot call remote: missing peer or remote ID');
    return;
  }

  // Never dial over a call that is already carrying media - that is what
  // produced the duplicate PeerConnections in the first place.
  if (isCallLive(currentCall)) {
    console.log('Call already live, not dialing again');
    return;
  }

  updateStatus(`Calling ${REMOTE_ID}...`);

  const call = peer.call(REMOTE_ID, localStream);

  if (!call) {
    console.log('Call failed to initiate');
    scheduleReconnect();
    return;
  }

  call.on('stream', (stream) => {
    handleRemoteStream(stream);
  });

  call.on('close', () => handleCallClosed(call, 'Call ended'));

  call.on('error', (err) => {
    console.error('Outgoing call error:', err);
    updateStatus(`Call error: ${err.message}`);
    handleCallClosed(call, 'Call error');
  });

  setCurrentCall(call);
}

function handleRemoteStream(stream) {
  console.log('Received remote stream');
  const remoteVideo = document.getElementById('remote-video');
  remoteVideo.srcObject = stream;
  remoteVideo.autoplay = true;
  remoteVideo.playsInline = true;
  remoteVideo.muted = false;
  remoteVideo.play().catch(err => {
    // AbortError is expected when a second stream arrives and replaces the
    // source before the pending play() settles; the newer stream plays instead.
    if (err.name !== 'AbortError') {
      console.error(`Error playing remote video: ${err.name}: ${err.message}`);
    }
  });

  hideOfflineOverlay();
  resetReconnectAttempts();
  // Baseline against the connection this stream arrived on, so the first check
  // after a new call compares like with like.
  measuredConnection = currentCall && currentCall.peerConnection;
  lastBytesReceived = 0;
  lastMediaAt = Date.now();
  stalledChecks = 0;
  updateStatus('Connected');
}

function showOfflineOverlay() {
  document.getElementById('offline-overlay').classList.remove('hidden');
}

function hideOfflineOverlay() {
  document.getElementById('offline-overlay').classList.add('hidden');
}

// "Office Offline" means the far office's picture is not arriving. It does not
// mean the signaling connection hiccuped: media flows peer-to-peer and does not
// touch the server once a call is up, so a dropped WebSocket, a transient peer
// error, or navigator.onLine flapping on a Wi-Fi handoff say nothing about
// whether video is still playing. Covering a live picture because of those is
// worse than saying nothing - a display that cries offline while working is one
// nobody trusts when it is actually offline. A genuine media stall is caught by
// the watchdog within two checks.
// Same rule as the overlay, applied to the status label. A label reading
// "Disconnected" over a healthy picture is the same lie in smaller type, and
// these messages all describe the signaling connection, which the far office's
// video does not depend on once a call is up. The detail still goes to the
// console, where it is useful and harmless.
function setSignalingStatus(text) {
  if (mediaLooksLive()) {
    updateStatus('Connected');
    return;
  }
  updateStatus(text);
}

function showOfflineIfNoMedia(reason) {
  // Deliberately not isCallLive(): that treats ICE 'disconnected' as dead, but
  // it is a transient warning state - a dropped signaling socket pushes the
  // PeerConnection through it while frames keep arriving. Connection state is
  // the wrong question anyway. The only thing that decides whether to cover the
  // picture is whether the picture is arriving.
  if (mediaLooksLive()) {
    console.log(`${reason} while media is still arriving - leaving the picture up`);
    return;
  }
  showOfflineOverlay();
}

function connectData() {
  if (!peer || !REMOTE_ID) return;
  if (dataConn && dataConn.open) return;

  if (dataConn) {
    try {
      dataConn.close();
    } catch (err) {
      console.error('Could not close previous data connection:', err.message);
    }
  }

  const conn = peer.connect(REMOTE_ID);
  setupDataConnection(conn);
}

function setupDataConnection(conn) {
  dataConn = conn;

  conn.on('open', () => {
    console.log('Data connection established');
    if (localVideoRotation !== 0) {
      conn.send({ type: 'rotation', rotation: localVideoRotation });
    }
  });

  conn.on('data', (data) => {
    if (data.type === 'rotation') {
      const remoteVideo = document.getElementById('remote-video');
      const isPortrait = data.rotation === 90 || data.rotation === 270;
      remoteVideo.style.transform = `translate(-50%, -50%) rotate(${data.rotation}deg)`;
      remoteVideo.classList.toggle('portrait', isPortrait);
    }
  });

  conn.on('close', () => {
    console.log('Data connection closed');
    dataConn = null;
  });
}

let reconnectTimeout = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;
const BASE_RECONNECT_DELAY = 2000;

function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  reconnectAttempts++;
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);

  setSignalingStatus(`Reconnecting in ${Math.round(delay/1000)}s...`);

  reconnectTimeout = setTimeout(() => {
    reconnect();
  }, delay);
}

function reconnect() {
  if (!navigator.onLine) {
    setSignalingStatus('Offline, waiting for network...');
    return;
  }

  if (peer && peer.destroyed) {
    console.log('Peer destroyed, creating new connection...');
    connectToPeerServer();
  } else if (peer && !peer.disconnected) {
    // The answerer has nothing to retry here: dialing is the caller's job, and
    // a redundant dial from this side is what created the second connection.
    if (!IS_CALLER) {
      console.log('Peer still connected, waiting for the caller');
      return;
    }
    console.log('Peer still connected, attempting call...');
    callRemote();
    connectData();
  } else if (peer) {
    console.log('Attempting peer reconnect...');
    peer.reconnect();
  } else {
    console.log('No peer, creating new connection...');
    connectToPeerServer();
  }
}

// Last night's failure was silent: the call stayed "Connected", the tracks were
// live but muted, and nothing in the client noticed that no frames had arrived
// for hours. On an unattended display nobody is there to spot a black screen, so
// this watches for media actually moving rather than for an error.
const STALL_CHECK_MS = 60000;
// One odd sample is not an outage. The overlay waits for a second consecutive
// stalled check, so a single hiccup never covers a working picture.
const STALLED_CHECKS_BEFORE_OVERLAY = 2;
const STALLED_CHECKS_BEFORE_RECONNECT = 3;
const STALLED_CHECKS_BEFORE_RELOAD = 8;

// How recently bytes have to have arrived for the picture to count as live.
// Longer than the check interval, so a signaling blip landing just before the
// next sample does not read as an outage. If media really has stopped, the
// watchdog covers the screen a couple of checks later anyway.
const MEDIA_FRESH_MS = 90000;

let lastBytesReceived = 0;
let lastMediaAt = 0;
let stalledChecks = 0;

function mediaLooksLive() {
  return Boolean(currentCall) && (Date.now() - lastMediaAt) < MEDIA_FRESH_MS;
}
// Which PeerConnection lastBytesReceived was measured on. bytesReceived is
// per-connection and starts from zero, so comparing a new call's counter
// against the previous call's total reads as a stall for as long as it takes
// the new one to out-total the old - on a healthy call, minutes of false
// alarms ending in the watchdog tearing down a connection that was fine.
let measuredConnection = null;

async function inboundBytes() {
  const pc = currentCall && currentCall.peerConnection;
  if (!pc) return null;

  try {
    const stats = await pc.getStats();
    const byId = {};
    stats.forEach((report) => { byId[report.id] = report; });

    let bytes = 0;
    const quality = { at: Date.now() };

    stats.forEach((report) => {
      if (report.type === 'inbound-rtp') {
        bytes += report.bytesReceived || 0;

        if (report.kind === 'video') {
          quality.width = report.frameWidth;
          quality.height = report.frameHeight;
          quality.fps = report.framesPerSecond;
          quality.videoBytes = report.bytesReceived || 0;
          quality.packetsLost = report.packetsLost || 0;
          quality.packetsReceived = report.packetsReceived || 0;
          // Anything the far end had to drop and resend, or the decoder had to
          // conceal, shows up here before it shows up as a visibly worse image.
          quality.nacks = report.nackCount;
          quality.freezeCount = report.freezeCount;
        }
      }

      if (report.type === 'candidate-pair' && (report.nominated || report.state === 'succeeded')) {
        quality.rttMs = report.currentRoundTripTime !== undefined
          ? Math.round(report.currentRoundTripTime * 1000)
          : undefined;
        const local = byId[report.localCandidateId];
        const remote = byId[report.remoteCandidateId];
        quality.path = `${local && local.candidateType}->${remote && remote.candidateType}`;
      }
    });

    return { pc, bytes, quality };
  } catch (err) {
    console.error('Could not read call stats:', err.message);
    return null;
  }
}

// Logged once a minute so a display's own log answers "is the picture getting
// worse, and is it the network?" without anyone having to be standing there
// when it happens. Resolution and bitrate say what the far end is sending;
// loss, nacks and freezes say whether the path is struggling to carry it.
let lastQuality = null;

function logQuality(quality) {
  if (!quality || quality.videoBytes === undefined) return;

  let bitrate = '?';
  if (lastQuality && quality.at > lastQuality.at) {
    const seconds = (quality.at - lastQuality.at) / 1000;
    const delta = quality.videoBytes - lastQuality.videoBytes;
    if (delta >= 0) bitrate = Math.round((delta * 8) / seconds / 1000);
  }

  let lossPct = '?';
  if (lastQuality) {
    const lost = quality.packetsLost - lastQuality.packetsLost;
    const got = quality.packetsReceived - lastQuality.packetsReceived;
    if (got + lost > 0) lossPct = ((lost / (got + lost)) * 100).toFixed(2);
  }

  console.log(
    `media: ${quality.width || '?'}x${quality.height || '?'} @${quality.fps || '?'}fps ` +
    `${bitrate}kbps loss ${lossPct}% rtt ${quality.rttMs === undefined ? '?' : quality.rttMs}ms ` +
    `nacks ${quality.nacks || 0} freezes ${quality.freezeCount || 0} via ${quality.path || '?'}`
  );

  lastQuality = quality;
}

async function checkForStall() {
  const sample = await inboundBytes();

  // No call at all is the reconnect logic's business, not this watchdog's.
  if (sample === null) {
    stalledChecks = 0;
    return;
  }

  logQuality(sample.quality);

  // A different connection than last time: rebaseline rather than compare
  // across them. Not a stall, and not evidence of health either.
  if (sample.pc !== measuredConnection) {
    measuredConnection = sample.pc;
    lastQuality = null;
    lastBytesReceived = sample.bytes;
    stalledChecks = 0;
    return;
  }

  if (sample.bytes > lastBytesReceived) {
    lastBytesReceived = sample.bytes;
    lastMediaAt = Date.now();
    stalledChecks = 0;
    // Media is moving, so anything the watchdog put up should come down. It is
    // the only thing that can clear its own overlay: handleRemoteStream fires
    // once per call, so without this a single stalled check leaves "Office
    // Offline" over a live picture until the next reconnect.
    hideOfflineOverlay();
    return;
  }

  stalledChecks++;
  console.warn(`No media for ${stalledChecks} check(s) (${sample.bytes} bytes total)`);
  if (stalledChecks >= STALLED_CHECKS_BEFORE_OVERLAY) showOfflineOverlay();

  // A full page reload is the only thing that reliably gives back ICE sockets
  // the renderer has leaked, which is what took the portal down overnight.
  if (stalledChecks >= STALLED_CHECKS_BEFORE_RELOAD) {
    // Prefer the desktop app's reload: it re-authenticates first, so a session
    // that expired while the app was running does not leave the display parked
    // on a login page. A plain location.reload() cannot do that, and on a
    // keyboard-less display nobody is there to notice or fix it.
    if (window.portal && window.portal.reloadPortal) {
      console.error('Media stalled too long - asking the app to re-authenticate and reload');
      window.portal.reloadPortal();
    } else {
      console.error('Media stalled too long - reloading the page');
      window.location.reload();
    }
    return;
  }

  if (stalledChecks >= STALLED_CHECKS_BEFORE_RECONNECT) {
    console.warn('Media stalled - tearing down the call and reconnecting');
    setCurrentCall(null);
    lastBytesReceived = 0;
    measuredConnection = null;
    if (peer && !peer.destroyed) peer.destroy();
    peer = null;
    connectToPeerServer();
  }
}

setInterval(checkForStall, STALL_CHECK_MS);

function resetReconnectAttempts() {
  reconnectAttempts = 0;
}

// Network status handlers
window.addEventListener('online', () => {
  console.log('Network online, reconnecting...');
  updateStatus('Network restored, reconnecting...');
  reconnect();
});

window.addEventListener('offline', () => {
  console.log('Network offline');
  setSignalingStatus('Network offline');
  // navigator.onLine only reports whether an interface is up, not whether the
  // far office is reachable, and it flaps on VPN and Wi-Fi handoffs.
  showOfflineIfNoMedia('Network reported offline');
});

// Reconnect when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    console.log('Tab visible, checking connection...');
    if (!currentCall || !peer || peer.disconnected) {
      reconnect();
    }
  }
});

function updateStatus(message) {
  const timestamp = new Date().toLocaleTimeString();
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = `[${timestamp}] ${message}`;
  }
  console.log(`Status: ${message}`);
}

// Control functions
window.toggleMute = function() {
  if (!localStream) return;

  isMuted = !isMuted;
  setCookie('muted', isMuted);
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });

  updateMuteUI();
};

window.toggleCamera = function() {
  isCameraHidden = !isCameraHidden;
  setCookie('cameraHidden', isCameraHidden);

  updateCameraUI();
};

function updateMuteUI() {
  const btn = document.getElementById('btn-mute');
  const icon = document.getElementById('mute-icon');
  btn.classList.toggle('active', isMuted);
  icon.textContent = isMuted ? '🚫' : '🎤';
}

function updateCameraUI() {
  const btn = document.getElementById('btn-camera');
  const icon = document.getElementById('camera-icon');
  const localVideo = document.getElementById('local-video');

  btn.classList.toggle('active', isCameraHidden);
  icon.textContent = isCameraHidden ? '🚫' : '📷';
  localVideo.style.display = isCameraHidden ? 'none' : 'block';
}

function applyInitialSettings() {
  updateMuteUI();
  updateCameraUI();
}

window.rotateCamera = function() {
  localVideoRotation = (localVideoRotation + 90) % 360;

  const localVideo = document.getElementById('local-video');
  localVideo.style.transform = `rotate(${localVideoRotation}deg)`;

  if (dataConn && dataConn.open) {
    dataConn.send({ type: 'rotation', rotation: localVideoRotation });
  }
};

window.toggleFullscreen = function() {
  // The desktop app runs frameless and already fullscreen, so the Fullscreen
  // API has nothing left to hide there - preload.js exposes the real window
  // instead. In a browser there is chrome to hide, so the API still applies.
  if (window.portal) {
    window.portal.toggleFullscreen();
    return;
  }

  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(err => {
      console.error('Fullscreen error:', err);
    });
  } else {
    document.exitFullscreen();
  }
};

document.addEventListener('fullscreenchange', () => {
  const icon = document.getElementById('fullscreen-icon');
  if (icon) {
    icon.textContent = document.fullscreenElement ? '⛶' : '⛶';
  }
});

window.goBack = function() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  if (peer) {
    peer.destroy();
  }
  window.location.href = window.location.pathname;
};
