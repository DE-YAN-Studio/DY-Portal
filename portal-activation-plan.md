# Portal Activation — Implementation Plan for Claude Code

> **Superseded.** This is the original build plan, kept for history. The
> signaling server now runs on Render rather than an Oracle Cloud VM with PM2,
> and displays run the Electron app in `electron/` rather than Chromium kiosk
> mode. See the README for current setup.

## Project Overview

Build an always-on, two-way video portal between two offices using WebRTC for peer-to-peer media and a self-hosted PeerJS server for signaling. The signaling server runs on an Oracle Cloud free-tier VM managed by PM2. The client runs as a local HTML file in Chromium kiosk mode on a dedicated machine at each office.

---

## Repository Structure

```
portal/
├── server/
│   ├── package.json
│   └── server.js          # PeerJS signaling server (also serves client files)
├── client/
│   ├── index.html
│   ├── main.js            # WebRTC + PeerJS client logic
│   ├── style.css
│   └── config.js          # Environment-specific config
├── scripts/
│   ├── start-kiosk.sh     # Launches Chromium in kiosk mode
│   └── watchdog.sh        # Restarts browser if it crashes
└── README.md
```

---

## Phase 1 — Signaling Server ✅ COMPLETED

### `server/package.json`
- Dependencies: `peer`, `express`
- Node version: 18+

### `server/server.js`
- Instantiate a PeerJS server using the `peer` npm package
- Mount it on Express at path `/peerjs`
- Enable the PeerJS debug dashboard at `/`
- Use Express to serve the `../client` folder as static files at `/client`
- Listen on `PORT` env variable, default `9000`
- Log when peers connect and disconnect
- Add a `/health` GET endpoint returning `{ status: "ok", peers: <count> }`

---

## Phase 2 — Client Application ✅ COMPLETED

### `client/config.js`

Export a config object with:

```js
export default {
  PEER_SERVER_HOST: '',      // Oracle VM public IP or domain
  PEER_SERVER_PORT: 9000,
  PEER_SERVER_PATH: '/peerjs',
  LOCAL_PEER_ID: '',         // e.g. 'office-ny' or 'office-serbia' — set per machine
  REMOTE_PEER_ID: '',        // the other office's peer ID
  RECONNECT_INTERVAL_MS: 10000,
  VIDEO_CONSTRAINTS: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 }
  },
  AUDIO_CONSTRAINTS: true
}
```

### `client/main.js`

Implement the following functions:

**`init()`**
- Call `getLocalStream()` then `connectToPeerServer()`

**`getLocalStream()`**
- Call `navigator.mediaDevices.getUserMedia` with video and audio constraints from config
- Attach the stream to `#local-video` element
- Store stream globally for use in calls

**`connectToPeerServer()`**
- Instantiate a `new Peer(LOCAL_PEER_ID, { host, port, path, secure: false })`
- On `peer.on('open')`: log connection, call `callRemote()`
- On `peer.on('call')`: answer with local stream, handle incoming stream via `handleRemoteStream()`
- On `peer.on('disconnected')`: attempt `peer.reconnect()`
- On `peer.on('error')`: log error, schedule `reconnect()` after interval

**`callRemote()`**
- Use `peer.call(REMOTE_PEER_ID, localStream)`
- On `call.on('stream')`: call `handleRemoteStream(stream)`
- On `call.on('close')` or `call.on('error')`: schedule `reconnect()`

**`handleRemoteStream(stream)`**
- Attach stream to `#remote-video` element
- Set `autoplay`, `playsinline`, `muted=false`
- Update UI status to "Connected"

**`reconnect()`**
- Wait `RECONNECT_INTERVAL_MS`
- If peer is destroyed, re-run `connectToPeerServer()`
- Otherwise call `callRemote()` again
- Update UI status to "Reconnecting…"

**`updateStatus(message)`**
- Update a visible `#status` overlay element with the message and a timestamp

---

### `client/index.html`

Structure:
- Full-screen layout, black background
- `#remote-video` — fills the entire screen, `object-fit: cover`
- `#local-video` — picture-in-picture in bottom-right corner, ~20% width
- `#status` — small overlay in top-left, shows connection status
- Load `config.js` and `main.js` as ES modules
- Include PeerJS client from CDN: `https://unpkg.com/peerjs@1.5.1/dist/peerjs.min.js`

### `client/style.css`
- Body: `margin: 0`, `background: black`, `overflow: hidden`
- Remote video: `position: absolute`, `width: 100vw`, `height: 100vh`, `object-fit: cover`
- Local video: `position: absolute`, `bottom: 20px`, `right: 20px`, `width: 20%`, `border: 2px solid white`, `border-radius: 8px`
- Status: `position: absolute`, `top: 16px`, `left: 16px`, `color: white`, `font-family: monospace`, `font-size: 13px`, `background: rgba(0,0,0,0.5)`, `padding: 6px 10px`, `border-radius: 4px`

---

## Phase 3 — Kiosk & Watchdog Scripts ✅ COMPLETED

### `scripts/start-kiosk.sh`
- Kill any existing Chromium processes
- Launch Chromium with flags:
  - `--kiosk`
  - `--autoplay-policy=no-user-gesture-required`
  - `--disable-infobars`
  - `--noerrdialogs`
  - `--check-for-update-interval=31536000`
- Point to `http://<PEER_SERVER_HOST>:9000/client/index.html`

### `scripts/watchdog.sh`
- Loop every 30 seconds
- Check if Chromium process is running
- If not, call `start-kiosk.sh`
- Log restarts with timestamp to `watchdog.log`

---

## Deployment Instructions

### On the Oracle Cloud VM (one-time setup)

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2

# Clone the repo and install dependencies
git clone <repo-url> portal
cd portal/server
npm install

# Start the server with PM2
pm2 start server.js --name portal-server

# Save PM2 process list and enable startup on reboot
pm2 startup
pm2 save
```

Then open port `9000` in Oracle Cloud firewall (Security List → Ingress Rules → TCP port 9000).

### On each office machine

1. Edit `client/config.js`:
   - Set `PEER_SERVER_HOST` to the Oracle VM's public IP
   - **NY machine**: `LOCAL_PEER_ID: 'office-ny'`, `REMOTE_PEER_ID: 'office-serbia'`
   - **Serbia machine**: `LOCAL_PEER_ID: 'office-serbia'`, `REMOTE_PEER_ID: 'office-ny'`
2. Run `scripts/start-kiosk.sh`
3. Run `scripts/watchdog.sh &` in the background, or register it as a systemd service

---

## Testing Checklist

- [ ] Signaling server `/health` returns 200
- [ ] Two browser tabs on localhost can connect to each other
- [ ] Closing one tab triggers reconnect loop on the other
- [ ] Video fills screen correctly in kiosk mode
- [ ] Audio is audible in both directions
- [ ] Simulate network drop — confirm auto-reconnect within 10s
- [ ] PeerJS dashboard shows correct peer count
