# TURN relay on Oracle Cloud

The portal needs a TURN relay. Both offices sit behind NATs that will not pass
direct UDP between them — ICE gathers reflexive candidates on both sides,
exchanges them correctly, sends connectivity checks, and gets **zero** responses
before failing at ~18s. The screens stay black while signaling looks perfectly
healthy, which is what makes this failure so confusing.

Oracle Cloud's Always Free tier includes **10 TB/month of outbound transfer**
with inbound unmetered. An always-on 1080p portal relays roughly **1.3 TB/month**
of egress, so this fits inside the free tier with room to spare and stays free
indefinitely.

> Do not substitute a free public TURN service. Two of them have already taken
> this portal down: PeerJS's built-in relays were decommissioned, and Metered's
> open credentials were retired. Both failed silently.

## 1. Create the instance

An **Ampere A1 (ARM)** shape on the Always Free tier is plenty — coturn forwards
packets and barely touches CPU. Ubuntu, so it matches the VM this project used
before. Assign it a **reserved** public IP, not an ephemeral one: the IP goes
into the portal's config, and an ephemeral address changes on stop/start.

## 2. Open the ports — twice

This is where Oracle deployments usually fail. There are two independent
firewalls and traffic must pass both.

**a. VCN security list** (Networking → VCN → Subnet → Security List → Add Ingress
Rules), all with source `0.0.0.0/0`:

| Protocol | Port range | Purpose |
|----------|-----------|---------|
| UDP | 3478 | TURN/STUN |
| TCP | 3478 | TURN over TCP, for offices that block UDP |
| UDP | 49160-49200 | relay ports (`min-port`/`max-port`) |

**b. The instance's own firewall.** Oracle's Ubuntu images ship iptables rules
that reject everything else, and there is a `REJECT` rule the new rules must be
inserted *above* — appending them has no effect:

```bash
sudo iptables -I INPUT -p udp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 49160:49200 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Install coturn

```bash
sudo apt update && sudo apt install -y coturn
sudo install -m 640 -o root -g turnserver turnserver.conf /etc/turnserver.conf
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo -u turnserver test -r /etc/turnserver.conf && echo "config is readable"
```

**The ownership on that `install` line is load-bearing.** coturn runs as the
`turnserver` user. If it cannot read the config it does not fail or warn — it
starts with every default instead. That costs you `external-ip` (relay
candidates advertise the unreachable private address), the port range, and
`lt-cred-mech`, which means **no authentication at all**: an open relay on the
public internet that anyone can pipe traffic through. It looks like a working
server, and `turnutils_uclient` will even report success, because the
allocation is being granted without checking the password.

Then edit `/etc/turnserver.conf` and replace three placeholders:

- `user=portal:REPLACE_WITH_A_LONG_RANDOM_PASSWORD` — generate with
  `openssl rand -base64 24`
- `external-ip=REPLACE_PUBLIC_IP/REPLACE_PRIVATE_IP` — public first, then the
  private address from `ip -4 addr show` (typically `10.0.0.x`)

The `external-ip` line is the one that silently breaks everything if it's wrong.
The instance never sees its own public address — Oracle NATs it — so without
this, coturn hands out relay candidates pointing at a private address that no
office can reach, and the failure looks exactly like having no TURN at all.

```bash
sudo systemctl restart coturn && sudo systemctl status coturn --no-pager
```

## 4. Verify the relay before touching the portal

From the VM, using coturn's own test client:

```bash
turnutils_uclient -v -u portal -w 'YOUR_PASSWORD' YOUR_PUBLIC_IP
```

Read the relayed address carefully — success alone is not enough:

```
0: : IPv4. Received relay addr: 158.101.123.209:49194
```

It must be the **public** IP and a port **inside** `min-port`–`max-port`. A
private address (`10.x`) or an out-of-range port means the config was not read
— see the ownership note above. Then confirm the credentials are actually being
enforced, which is the check that catches a silently-open relay:

```bash
turnutils_uclient -v -y -u portal -w wrong-password YOUR_PUBLIC_IP
```

This **must** print `ERROR: Cannot complete Allocation`. If it succeeds, your
relay is open to the world.

A timeout instead means a firewall is still closed — check the instance's
iptables first, since that's the one people forget.

## 5. Point the portal at it

In the Render dashboard:

| Variable | Value |
|----------|-------|
| `TURN_URLS` | `turn:YOUR_PUBLIC_IP:3478,turn:YOUR_PUBLIC_IP:3478?transport=tcp` |
| `TURN_USERNAME` | `portal` |
| `TURN_CREDENTIAL` | the password from step 3 |

**Use the IP address, not a hostname.** DNS is a real failure mode here: Chromium
resolves ICE hostnames through its own resolver, and this project has already hit
`701 STUN host lookup received error` on a TURN hostname that the system resolver
handled fine. An IP removes that entire class of problem, and a reserved Oracle
IP is stable.

Render redeploys on save. Restart both displays, then confirm:

```bash
"/Applications/DY Portal.app/Contents/MacOS/DY Portal" 2>&1 | grep -E "ICE servers|Received remote stream"
```

`ICE servers:` should list the `turn:` entry, and video should appear within a
few seconds.

## Confirming the relay is actually being used

`Received remote stream` is **not** proof — PeerJS fires it when the track is
attached during negotiation, before any media arrives. The reliable check is in
the browser/devtools console on a display:

```js
const v = document.getElementById('remote-video');
({ w: v.videoWidth, muted: v.srcObject?.getTracks().map(t => t.muted) })
```

Real video means non-zero `videoWidth` and `muted: [false, false]`. Tracks that
stay `muted: true` mean the connection negotiated but no media is flowing.

## Cost control

Relayed traffic is billed egress, so it's worth watching. Roughly 2 Mbps per
direction at 1080p means about 1.3 TB/month against a 10 TB allowance. If you add
displays or raise the resolution, re-check that headroom — and note the relay
only carries traffic when a direct path is unavailable, so an office network
change could take this to zero on its own.
