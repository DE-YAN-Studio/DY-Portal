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

### 3. Set up TURN

WebRTC carries the video peer-to-peer, and two offices behind NAT usually cannot
reach each other directly — they need a relay. Point these at a TURN provider:

| Variable | Value |
|----------|-------|
| `TURN_URLS` | comma-separated, e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349` |
| `TURN_USERNAME` | provider username |
| `TURN_CREDENTIAL` | provider credential |
| `STUN_URLS` | optional; defaults to `stun:stun.cloudflare.com:3478` |

The client fetches this from `/api/ice` at every connection, so credentials stay
on the server, rotate without redeploying a display, and never sit in the repo.

**Do not rely on the defaults built into PeerJS.** It ships a hardcoded list
pointing at `eu-0.turn.peerjs.com` and `us-0.turn.peerjs.com`, which no longer
resolve. The failure is quiet and misleading: signaling connects, both offices
appear in `/health`, and the screens stay black. If TURN is unset the server says
so at startup, and `/api/ice` serves STUN alone.

Verify what a display is actually being given:

```bash
grep "ICE servers:" /Users/Shared/portal/portal.log
```

### 4. Access the portal

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
│   └── com.deyan.portal.plist  # macOS launch-at-login + restart
└── README.md
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` | Redirects to login or portal |
| `/login` | Login page |
| `/api/login` | POST: authenticate with password |
| `/api/logout` | POST: clear session |
| `/api/ice` | GET: `{ iceServers }` for WebRTC; requires a session |
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

There is **no default office**. An unconfigured app shows a "Not configured"
screen and opens Settings rather than guessing: a default identity would have a
fresh install claim an ID a real display already holds, and that collision is
silent — the loser is refused with `ID is taken` and retries forever, so
whichever machine wins the race decides which office goes dark.

On a machine that already has the app installed, you don't need to touch the
file at all — press `Cmd+Ctrl+Shift+S` on the display and use the **Settings**
window (see [Settings window](#settings-window)).

This file holds the password and is gitignored. Every value can also be
overridden by environment variable: `PORTAL_URL`, `PORTAL_PASSWORD`,
`PORTAL_LOCAL_OFFICE`, `PORTAL_REMOTE_OFFICE`, `PORTAL_KIOSK`.

`kiosk` is **off by default**. The window is already fullscreen and frameless
without it, so it only adds a lock: no app switching and no way out of
fullscreen. That is what an unattended display wants, so set `"kiosk": true` on
the two office machines — but leave it off anywhere you also intend to use the
computer, because a kiosk window is genuinely hard to escape (see
[Kiosk shortcuts](#kiosk-shortcuts)). If the process is killed while kiosk is
active, macOS can be left with the Dock and menu bar still hidden; `killall
Dock` puts them back.

### Settings window

Pressing `Cmd+Ctrl+Shift+S` (`Ctrl+Shift+S` on Windows) on a running display
opens a settings window for the server URL, password, the two office IDs, and
kiosk mode. It writes `portal.config.json` to the userData path below, then
re-authenticates and reloads the portal in place — no restart, and nothing to
type into a terminal on a machine that may have no keyboard attached.

It is deliberately undiscoverable: no menu item, no on-screen control, and the
same three-modifier chord as quit, so a display in a shared space does not
present a password field to anyone who brushes the keyboard.

The office is a **dropdown**, not a text field, and there is only one: you pick
which display this machine is, and the office it calls is derived from the pair.
That makes "local and remote are the same" structurally impossible instead of
something to catch in validation, and removes the chance of a typo in an ID that
has to match exactly on both ends.

Three ways in, in descending order of reliability on a locked-down display:

| Route | Works when |
|-------|-----------|
| `Cmd+Ctrl+Shift+S` / `Ctrl+Shift+S` | always, including kiosk mode |
| **Settings…** in the app menu (`Cmd+,`) | app focused; the accelerator works even when the menu bar is hidden |
| **DY Portal** menu-bar icon → Open Settings | only while the menu bar is visible — hover the top edge in fullscreen; never in kiosk mode |

The window is fullscreen and covers the menu bar, so the menu-bar icon is not a
substitute for the chord on an unattended display. Keep the chord written down
somewhere.

It also carries a **Launch at login** checkbox, which registers the app with
macOS directly — no plist to hand-install. Note what it does and does not cover:
it starts the portal when the user logs in, but nothing relaunches the app if
the process dies. For that you still want the LaunchAgent in `scripts/`, whose
`KeepAlive` restarts it on an abnormal exit (see
[Launch at Login](#launch-at-login-unattended-displays)). The checkbox is
disabled in development, where it would register the Electron binary rather
than the portal.

If any `PORTAL_*` environment variable is set, the window says so and names it:
env vars outrank the config file, so a value typed here would otherwise be
saved and silently ignored.

Two things it enforces that hand-editing does not:

- **Local and remote office must differ.** Two displays claiming the same ID is
  not a loud failure — the second is rejected by the signaling server with
  `ID is taken`, retries forever, and *both* offices show as offline.
- **A blank password field keeps the stored password** rather than clearing it,
  so changing an office ID cannot silently strand a display on the login page.

The stored password is never sent to the settings window — only whether one
exists. The window also gets its own preload script: the portal window loads
remote content from the server and is handed nothing but a fullscreen toggle.

### Run and package

```bash
npm start                  # run it
npm run dist:mac           # build a .dmg
npm run dist:win           # build an .exe installer
```

For a packaged app, put `portal.config.json` in the app's userData directory
instead of the bundle, so the password isn't baked into a shipped binary:

- macOS: `~/Library/Application Support/dy-portal-desktop/portal.config.json`
- Windows: `%APPDATA%\dy-portal-desktop\portal.config.json`

The folder is `dy-portal-desktop`, not `DY Portal`: Electron derives userData from
the `name` in `package.json`, and `productName` is set inside the `build` block,
which only electron-builder reads. Get this path wrong and the app silently falls
back to its defaults — the production URL with an empty password — which on a
display with no keyboard means it sits on the login page.

Without a config file the app is pointed at production but cannot log itself in,
so this step is what makes an unattended display work at all.

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

The window is frameless and fullscreen whether or not kiosk mode is on, so there
is no title bar to close it with. These are the way out:

| Shortcut | Action |
|----------|--------|
| `Cmd+Q` | Quit (macOS, ordinary menu shortcut) |
| `Cmd+Ctrl+Shift+Q` / `Ctrl+Shift+Q` | Quit (macOS / Windows) |
| `Cmd/Ctrl+Shift+R` | Reload the portal |
| `Cmd/Ctrl+Shift+I` | Toggle DevTools |
| `Cmd+Ctrl+Shift+S` / `Ctrl+Shift+S` | Open Settings (macOS / Windows) |

Reload and DevTools take two modifiers; quit and settings take three, so a
stray keypress on a shared display cannot kill the portal or open its password
field. `Cmd/Ctrl+Shift+R` is stronger than a browser refresh: it re-authenticates
before reloading, so it also recovers a display whose session has expired.

Quit takes Control as well on macOS: `Cmd+Shift+Q` is the Apple menu's **Log
Out** shortcut, and macOS claims it before the window sees it, so a quit bound
there would never fire.

They need the portal window focused and its renderer alive. If it is wedged hard
enough not to take input, kill the process instead — the supervisor will bring it
back. To stop it and have it *stay* stopped, see
[Stopping it on purpose](#stopping-it-on-purpose).

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

Displays are macOS only. `npm run dist:win` still works for testing the app on a
Windows dev machine, but there is no supervisor for it — run it by hand.

### Stopping it on purpose

`Cmd+Shift+Q` exits cleanly and stays stopped: `KeepAlive` restarts the app only
on *abnormal* exit. `pkill` **is** an abnormal exit, so launchd brings it right
back — quitting it harder is the wrong instinct here.

To stop it for maintenance, unload the agent first:

```bash
launchctl unload ~/Library/LaunchAgents/com.deyan.portal.plist
pkill -f "DY Portal"
# re-enable
launchctl load -w ~/Library/LaunchAgents/com.deyan.portal.plist
```

### Verifying it works

Kill the app and confirm it comes back:

```bash
pkill -f "DY Portal"
```

It should relaunch within ~10 seconds (the `ThrottleInterval`). Then reboot the
machine and confirm the portal returns unattended — that also verifies auto-login
is enabled, without which the agent never runs.

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
