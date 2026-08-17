# Portal

An always-on, two-way video portal connecting two offices using WebRTC for peer-to-peer video/audio and PeerJS for signaling.

## Features

- **Real-time video/audio** between two locations
- **Password protection** - login page with session cookies
- **Office selection UI** - choose your location on launch (remembered via cookie)
- **Camera controls** - mute mic, hide local video, rotate orientation, fullscreen
- **Synced rotation** - camera rotation syncs to remote viewer via data channel
- **Auto-hide UI** - controls fade away after 3 seconds, reappear on mouse movement
- **Auto-reconnect** - automatically reconnects on network issues
- **Auto-deploy** - Render deploys on every push to `master`
- **HTTPS/WSS** - terminated by Render, no certificate management
- **Desktop app** - self-logging-in Electron kiosk app for always-on displays

## Architecture

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────┐
│  Office NY  │◄───────►│      Render      │◄───────►│  Serbia     │
│  (Electron) │  WebRTC │  (PeerJS Server) │  WebRTC │  (Electron) │
└─────────────┘         │   + HTTPS/WSS    │         └─────────────┘
                        └──────────────────┘
```

- **PeerJS Server**: Handles WebRTC signaling (peer discovery, connection setup)
- **Render**: Hosts the server and terminates TLS
- **WebRTC**: Direct peer-to-peer video/audio (media doesn't go through server)

Both offices must be served by a **single** instance: PeerJS keeps its peer
registry in process memory, so a second instance would split the offices apart.
`render.yaml` pins `numInstances: 1`.

## Controls

| Button | Function |
|--------|----------|
| 🎤 | Mute/unmute microphone |
| 📷 | Show/hide local video preview |
| 🔄 | Rotate video orientation |
| ⛶ | Toggle fullscreen |
| 🌐 | Change office |

## Deploying the server (Render)

### 1. Create the service

In the Render dashboard: **New > Blueprint**, point it at this repo. Render reads
`render.yaml` and creates the `dy-portal` web service.

Use the **Starter** plan, not Free. Free instances spin down after 15 minutes
idle and cold-start in roughly a minute, which shows up as both offices sitting
on "Calling…" until the service wakes.

### 2. Set the password

`render.yaml` deliberately does not contain the password. In the service's
**Environment** tab, set:

| Variable | Value |
|----------|-------|
| `PORTAL_PASSWORD` | your chosen login password |
| `SESSION_SECRET` | generated automatically by Render - leave it alone |

Rotating `SESSION_SECRET` signs every office out, so change it only on purpose.

### 3. Access the portal

Open the service's `https://<name>.onrender.com` URL. You'll be prompted to log
in, then redirected to the portal.

There is nothing to configure in `client/config.js` - it derives the signaling
host from the URL the page was served from, so it works on the Render domain, on
a custom domain, and on `localhost` without edits.

Pushes to `master` redeploy automatically.

## Running locally

```bash
npm run build                                    # installs server deps
SESSION_SECRET=dev PORTAL_PASSWORD=dev npm start
# then open http://localhost:9000
```

These are the same two commands Render runs, so a local failure is a build
failure.

## Project Structure

```
portal/
├── render.yaml             # Render service definition
├── server/
│   ├── package.json
│   └── server.js           # PeerJS signaling server
├── client/
│   ├── index.html          # UI with office selection
│   ├── login.html          # Password login page
│   ├── main.js             # WebRTC + PeerJS client
│   ├── style.css
│   └── config.js           # Server connection settings
├── electron/
│   ├── main.js             # Kiosk desktop app
│   ├── offline.html        # Shown while reconnecting
│   └── portal.config.example.json
├── scripts/
│   ├── com.deyan.portal.plist  # macOS launch-at-login + restart
│   └── dy-portal-task.xml      # Windows launch-at-login + restart
└── README.md
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` | Redirects to login or portal |
| `/login` | Login page |
| `/api/login` | POST: authenticate with password |
| `/api/logout` | POST: clear session |
| `/health` | Health check: `{ status, peers, peerIds }` |
| `/client/` | Portal web client (requires auth) |
| `/peerjs` | PeerJS WebSocket endpoint |

## Desktop App (recommended for displays)

`electron/` is a kiosk app that replaces the Chrome kiosk scripts. It logs itself
in, so a display with no keyboard needs no attention:

- Authenticates from config, skipping the login page
- Grants its own camera/microphone access (portal origin only)
- Pins the office, skipping the office-selection screen
- Blocks display sleep
- Reloads on renderer crash, hang, or network loss, with backoff
- Reopens its window if it is lost, instead of exiting
- Shows a "Reconnecting" screen instead of a browser error page

It cannot restart itself if the whole process dies, and it cannot start after a
reboot — see [Launch at Login](#launch-at-login-unattended-displays), which is
what replaces the old watchdog scripts.

### Configure

```bash
cd electron
npm install
cp portal.config.example.json portal.config.json
```

Edit `portal.config.json` — set `portalUrl` to your Render URL, `password` to
`PORTAL_PASSWORD`, and `localOffice`/`remoteOffice` per machine (NY gets
`office-ny` / `office-serbia`; Serbia gets the reverse).

This file holds the password and is gitignored. Every value can also be
overridden by environment variable: `PORTAL_URL`, `PORTAL_PASSWORD`,
`PORTAL_LOCAL_OFFICE`, `PORTAL_REMOTE_OFFICE`, `PORTAL_KIOSK`.

### Run and package

```bash
npm start                  # run it
npm run dist:mac           # build a .dmg
npm run dist:win           # build an .exe installer
```

For a packaged app, put `portal.config.json` in the app's userData directory
instead of the bundle, so the password isn't baked into a shipped binary:

- macOS: `~/Library/Application Support/DY Portal/portal.config.json`
- Windows: `%APPDATA%\DY Portal\portal.config.json`

macOS builds must run **on a Mac** — electron-builder cannot produce macOS
artifacts from Windows or Linux. Full display setup is in
[docs/MAC_SETUP.md](docs/MAC_SETUP.md).

### Code signing

The macOS build is currently **unsigned** (`"identity": null` — ad-hoc only,
which is the minimum Apple Silicon needs to launch at all). That has two costs:

1. Gatekeeper blocks the first launch until you clear quarantine with
   `xattr -dr com.apple.quarantine "/Applications/DY Portal.app"` or approve it
   in System Settings. One-time, per machine.
2. **macOS ties camera and microphone grants to the code signature.** Without a
   stable Developer ID, a rebuild can read as a different app and re-prompt for
   both — and an unattended kiosk has nobody to click Allow, so the portal comes
   up black. Re-check video after every app update.

To sign later: an Apple Developer account and a Developer ID Application
certificate, then drop `"identity": null`, add `"hardenedRuntime": true` and
`"notarize": true`, and set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID` at build time. The entitlements in
`electron/build/entitlements.mac.plist` already declare the camera and
microphone access notarization requires, so they are left in place.

Windows installers are unsigned too, which shows a one-time SmartScreen warning.
There is no permission-persistence equivalent on Windows, so this matters much
less.

### Kiosk shortcuts

Kiosk mode hides the window chrome, so these are the way out:

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+Shift+Q` | Quit |
| `Cmd/Ctrl+Shift+R` | Reload the portal |
| `Cmd/Ctrl+Shift+I` | Toggle DevTools |

## Launch at Login (unattended displays)

The app recovers on its own from renderer crashes, hangs, network loss, and
losing its window. It cannot restart itself if the whole process dies, and it
cannot start itself after a reboot — that needs the OS. Set up one of these on
each display machine so a power cut ends with the portal back up and nobody
touching a keyboard.

### macOS

```bash
mkdir -p /Users/Shared/portal          # log destination
cp scripts/com.deyan.portal.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.deyan.portal.plist
```

Assumes the app is at `/Applications/DY Portal.app`; edit the plist if not.

It must be a **LaunchAgent** in `~/Library/LaunchAgents`, not a LaunchDaemon in
`/Library/LaunchDaemons` — daemons run outside the GUI login session and cannot
reach the camera, microphone, or a display.

`KeepAlive` is set to restart only on *abnormal* exit, so `Cmd+Shift+Q` stays a
real escape hatch rather than triggering an instant relaunch.

Check on it and read the log:

```bash
launchctl list | grep com.deyan.portal
tail -f /Users/Shared/portal/portal.log
```

### Windows

Edit the `<Command>` path in `scripts/dy-portal-task.xml` if you did not install
to the default per-user location, then, in an Administrator prompt:

```
schtasks /create /tn "DY Portal" /xml scripts\dy-portal-task.xml
```

There is no launchd equivalent here, so the task leans on the app's
single-instance lock: it tries to start the portal at logon and every 5 minutes
after. If the portal is already running the new copy sees the lock and exits
immediately, making the repeat a no-op; if it died, the repeat brings it back.

```
schtasks /query /tn "DY Portal"
```

### Verifying it works

Kill the app and confirm it comes back:

```bash
pkill -f "DY Portal"          # macOS
taskkill /IM "DY Portal.exe" /F   # Windows
```

macOS should relaunch within ~10 seconds (the `ThrottleInterval`), Windows within
5 minutes. Then reboot the machine and confirm the portal returns unattended.

## URL Parameters

Override office settings via URL:

```
/client/index.html?local=office-ny&remote=office-serbia
```

## Troubleshooting

**Camera not working**
- Ensure you're using HTTPS (required for camera access)
- Check browser permissions for camera/microphone
- Try a different browser

**Connection stuck on "Calling..."**
- Verify both offices are connected to the signaling server
- Check `/health` endpoint for connected peers
- Ensure firewall allows WebRTC traffic

**Video lag or poor quality**
- WebRTC uses direct peer-to-peer - quality depends on network between offices
- Check network bandwidth and latency

**Connects, then drops after a while, or never connects at all**
- There is no TURN relay configured, so a restrictive NAT on either side leaves
  the peers unable to find a direct path. Signaling will look healthy while media
  never flows. Adding a TURN server is the fix; Render cannot provide one.

**Both offices keep getting logged out**
- Check `SESSION_SECRET` is set in Render. Without it the server generates a
  random one per boot and every restart invalidates all sessions.

**Long pause before the portal appears**
- The service is on Render's Free plan and is cold-starting. Move it to Starter.

## License

MIT
