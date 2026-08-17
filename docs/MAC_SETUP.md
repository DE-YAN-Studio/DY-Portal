# Mac Mini Portal Setup Guide

Complete setup for running the Portal on a Mac Mini as a dedicated always-on
display, using the Electron desktop app.

## Prerequisites

- Mac Mini with macOS
- A Mac with Node.js to build the app (can be the Mac Mini itself)
- Network connection
- Portal password (get from admin)

## Step 1: Build the app

The build must run **on a Mac** — electron-builder cannot produce macOS
artifacts from Windows or Linux.

```bash
cd electron
npm install
npm run dist:mac
```

Output lands in `electron/dist/`: a `.dmg` and `.zip` for both `arm64` (Apple
Silicon) and `x64` (Intel). Match the architecture to the Mac Mini — `uname -m`
prints `arm64` or `x86_64`.

## Step 2: Install it

Copy `DY Portal.app` into `/Applications`.

The build is **unsigned** (ad-hoc signed only), so macOS quarantines it and
refuses the first launch. Clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/DY Portal.app"
```

Alternatively, launch it once from Finder and approve it under **System Settings
> Privacy & Security**, where it appears as blocked.

Transferring the app by USB or `scp` rather than downloading it often avoids the
quarantine flag being set at all.

> **Unsigned builds and permissions.** macOS ties camera and microphone grants to
> an app's code signature. Without a stable Developer ID, a rebuilt app can be
> treated as a different app, and macOS will prompt for camera and mic again —
> on a kiosk with nobody watching, that means the portal comes up black behind a
> dialog. After **every** app update, verify the portal still has video, and
> re-approve under Privacy & Security if not. Signing removes this failure mode;
> see the README.

## Step 3: Configure the machine's office

Create `~/Library/Application Support/DY Portal/portal.config.json`:

```json
{
  "portalUrl": "https://dy-portal.onrender.com",
  "password": "the-portal-password",
  "localOffice": "office-ny",
  "remoteOffice": "office-serbia",
  "kiosk": true
}
```

On the Serbia machine, swap `localOffice` and `remoteOffice`.

Keeping the config here rather than inside the bundle means the password is not
baked into a shipped binary, and one build serves both offices.

## Step 4: Grant camera and microphone access

Launch the app once from Finder. macOS prompts for camera and microphone on first
run — accept both. The prompt appears only once; if it is missed or refused, the
portal comes up black. Fix it in **System Settings > Privacy & Security >
Camera** / **Microphone**, enabling **DY Portal**.

The app grants the *web page* its own permissions, but it cannot bypass this
OS-level gate.

## Step 5: Enable launch at login

```bash
mkdir -p /Users/Shared/portal          # log destination
cp scripts/com.deyan.portal.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.deyan.portal.plist
```

This starts the portal at login and restarts it if the process dies. It must be a
LaunchAgent in `~/Library/LaunchAgents`, not a LaunchDaemon — daemons run outside
the GUI login session and cannot reach the camera, microphone, or a display.

Verify:

```bash
launchctl list | grep com.deyan.portal
tail -f /Users/Shared/portal/portal.log
```

## Step 6: Configure macOS for kiosk use

### Disable sleep

1. **System Settings** > **Displays** > **Advanced...**
2. Turn **on** "Prevent automatic sleeping when the display is off"
3. **System Settings** > **Lock Screen**
4. Set "Turn display off when inactive" to **Never**
5. Set "Require password after screen saver" to **Never**

The app also blocks display sleep programmatically, but the lock screen would
still cover the portal, so both are needed.

### Auto-login

Required for an unattended machine — the LaunchAgent only runs once a user is
logged in, so without this a reboot stops at the login window.

1. **System Settings** > **Users & Groups**
2. Click **Login Options**
3. Set "Automatic login" to your user account

### Hide menu bar and Dock

1. **System Settings** > **Desktop & Dock** > enable "Automatically hide and show the Dock"
2. **System Settings** > **Control Center** > set "Automatically hide and show the menu bar" to **Always**

### Disable notifications

**System Settings** > **Notifications** — turn off notifications for all apps, or
enable **Do Not Disturb**, so nothing pops over the portal.

## Kiosk shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+Q` | Quit |
| `Cmd+Shift+R` | Reload the portal |
| `Cmd+Shift+I` | Toggle DevTools |

A deliberate quit stays quit — the LaunchAgent restarts the app only on abnormal
exit, so these do not fight each other.

## Troubleshooting

### Portal is black, or shows a camera error

Check camera permissions (Step 4), that no other app holds the camera, and
reseat external cameras. This is also the first thing to check after an app
update, since an unsigned rebuild can reset the grant. The log names the exact
failure:

```bash
tail -50 /Users/Shared/portal/portal.log
```

### Stuck on "Calling…"

1. Check internet connection
2. Verify the other office is online
3. Check https://dy-portal.onrender.com/health for connected peers

If both offices appear at `/health` but no video arrives, it is likely NAT
traversal — there is no TURN relay configured. See the README.

### App does not come back after a crash or reboot

```bash
launchctl list | grep com.deyan.portal      # is the agent loaded?
launchctl unload ~/Library/LaunchAgents/com.deyan.portal.plist
launchctl load -w ~/Library/LaunchAgents/com.deyan.portal.plist
```

Confirm auto-login is enabled — without it, a reboot waits at the login window
and the agent never runs.

### Reset login and office selection

```bash
rm -rf ~/Library/Application\ Support/DY\ Portal/{Cookies,Cookies-journal}
```

The config file in that directory is what pins the office; leave it in place
unless you are reassigning the machine.

### Stop the portal for maintenance

```bash
launchctl unload ~/Library/LaunchAgents/com.deyan.portal.plist
pkill -f "DY Portal"
```

## Quick Reference

| Action | Command |
|--------|---------|
| Start manually | `open "/Applications/DY Portal.app"` |
| Stop it staying stopped | `launchctl unload ~/Library/LaunchAgents/com.deyan.portal.plist && pkill -f "DY Portal"` |
| Re-enable | `launchctl load -w ~/Library/LaunchAgents/com.deyan.portal.plist` |
| View logs | `tail -f /Users/Shared/portal/portal.log` |
| Exit kiosk | `Cmd+Shift+Q` |
