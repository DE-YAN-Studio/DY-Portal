const express = require('express');
const { ExpressPeerServer } = require('peer');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 9000;
const PASSWORD = process.env.PORTAL_PASSWORD || 'portal123';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set - using a random value. Sessions will not survive a restart.');
}

// Render terminates TLS at its proxy, so req.secure needs the forwarded header.
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());

// Sessions are stateless: the cookie carries its own issue time plus an HMAC
// over that time. Nothing is held in memory, so a redeploy or crash does not
// sign the kiosks out.
function issueSession() {
  const issuedAt = Date.now().toString();
  return `${issuedAt}.${signSession(issuedAt)}`;
}

function signSession(issuedAt) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(issuedAt).digest('hex');
}

function verifySession(cookie) {
  if (typeof cookie !== 'string') return false;

  const [issuedAt, signature] = cookie.split('.');
  if (!issuedAt || !signature) return false;

  const expected = signSession(issuedAt);
  const given = Buffer.from(signature, 'hex');
  const want = Buffer.from(expected, 'hex');
  if (given.length !== want.length) return false;
  if (!crypto.timingSafeEqual(given, want)) return false;

  const age = Date.now() - Number(issuedAt);
  return Number.isFinite(age) && age >= 0 && age < SESSION_MAX_AGE;
}

const server = app.listen(PORT, () => {
  console.log(`Portal server listening on port ${PORT}`);
});

const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/'
});

app.use('/peerjs', peerServer);

function requireAuth(req, res, next) {
  if (verifySession(req.cookies.session)) {
    return next();
  }
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/login.html'));
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (typeof password === 'string' && password === PASSWORD) {
    res.cookie('session', issueSession(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_MAX_AGE
    });
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ success: true });
});

app.use('/client', requireAuth, express.static(path.join(__dirname, '../client')));

app.get('/', (req, res) => {
  if (verifySession(req.cookies.session)) {
    res.redirect('/client/index.html');
  } else {
    res.redirect('/login');
  }
});

let connectedPeers = new Set();

peerServer.on('connection', (client) => {
  connectedPeers.add(client.getId());
  console.log(`Peer connected: ${client.getId()} (total: ${connectedPeers.size})`);
});

peerServer.on('disconnect', (client) => {
  connectedPeers.delete(client.getId());
  console.log(`Peer disconnected: ${client.getId()} (total: ${connectedPeers.size})`);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    peers: connectedPeers.size,
    peerIds: Array.from(connectedPeers)
  });
});
