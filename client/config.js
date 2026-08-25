// The signaling server is the same server that serves this page, so the
// connection details are derived from the current URL. This works unchanged on
// Render, on a custom domain, and on localhost during development - there is no
// hostname to keep in sync here.
const isSecure = window.location.protocol === 'https:';

export default {
  PEER_SERVER_HOST: window.location.hostname,
  PEER_SERVER_PORT: Number(window.location.port) || (isSecure ? 443 : 80),
  PEER_SERVER_SECURE: isSecure,
  PEER_SERVER_PATH: '/peerjs',
  LOCAL_PEER_ID: 'office-ny',          // e.g. 'office-ny' or 'office-serbia' - set per machine
  REMOTE_PEER_ID: 'office-serbia',     // the other office's peer ID
  RECONNECT_INTERVAL_MS: 10000,
  // Used only when /api/ice cannot be reached. STUN alone is enough for two
  // peers with a direct path to each other and useless for two that need a
  // relay, so this is a last resort, not a substitute for configuring TURN.
  ICE_SERVERS_FALLBACK: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  VIDEO_CONSTRAINTS: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 }
  },
  AUDIO_CONSTRAINTS: true
}
