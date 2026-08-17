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

function connectToPeerServer() {
  updateStatus('Connecting to signaling server...');

  peer = new Peer(LOCAL_ID, {
    host: config.PEER_SERVER_HOST,
    port: config.PEER_SERVER_PORT,
    path: config.PEER_SERVER_PATH,
    secure: config.PEER_SERVER_SECURE
  });

  peer.on('open', (id) => {
    console.log('Connected to peer server with ID:', id);
    updateStatus(`Connected as ${id}, calling remote...`);
    connectData();
    callRemote();
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

    call.on('close', () => {
      updateStatus('Call closed, reconnecting...');
      showOfflineOverlay();
      scheduleReconnect();
    });

    call.on('error', (err) => {
      console.error('Call error:', err);
      updateStatus(`Call error: ${err.message}`);
      showOfflineOverlay();
      scheduleReconnect();
    });

    currentCall = call;
  });

  peer.on('disconnected', () => {
    console.log('Disconnected from peer server, attempting reconnect...');
    updateStatus('Disconnected, reconnecting...');
    showOfflineOverlay();
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
    updateStatus(`Error: ${err.type}`);
    showOfflineOverlay();

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
    updateStatus('Connection closed');
    showOfflineOverlay();
    scheduleReconnect();
  });
}

function callRemote() {
  if (!peer || !REMOTE_ID) {
    console.log('Cannot call remote: missing peer or remote ID');
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

  call.on('close', () => {
    updateStatus('Call ended, reconnecting...');
    showOfflineOverlay();
    scheduleReconnect();
  });

  call.on('error', (err) => {
    console.error('Outgoing call error:', err);
    updateStatus(`Call error: ${err.message}`);
    showOfflineOverlay();
    scheduleReconnect();
  });

  currentCall = call;
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

  document.getElementById('offline-overlay').classList.add('hidden');
  resetReconnectAttempts();
  updateStatus('Connected');
}

function showOfflineOverlay() {
  document.getElementById('offline-overlay').classList.remove('hidden');
}

function connectData() {
  if (!peer || !REMOTE_ID) return;

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

  updateStatus(`Reconnecting in ${Math.round(delay/1000)}s...`);

  reconnectTimeout = setTimeout(() => {
    reconnect();
  }, delay);
}

function reconnect() {
  if (!navigator.onLine) {
    updateStatus('Offline, waiting for network...');
    return;
  }

  if (peer && peer.destroyed) {
    console.log('Peer destroyed, creating new connection...');
    connectToPeerServer();
  } else if (peer && !peer.disconnected) {
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
  updateStatus('Network offline');
  showOfflineOverlay();
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
