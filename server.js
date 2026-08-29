// QuietMeet — V1 server
// Express serves the static frontend. A single WebSocket connection per
// tab handles: identity/profile, matchmaking by chosen mode, WebRTC
// signaling relay, in-session text chat relay, and mutual-consent friending.
//
// Storage is in-memory only for V1 — restarting the server clears everyone.
// That's an intentional simplification, not an oversight.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- In-memory state -------------------------------------------------

/** userId -> profile { userId, username, bio, avatar } */
const profiles = new Map();
/** userId -> Set<userId> (mutual friends) */
const friendships = new Map();
/** userId -> WebSocket (only present while connected) */
const sockets = new Map();
/** userId -> current sessionId (only present while in a session) */
const inSession = new Map();
/** modeKey -> [userId, ...] waiting queue */
const queues = new Map();
/** userId -> modeKey they're queued under (for cancel/cleanup) */
const queuedAs = new Map();
/** sessionId -> { a, b, mode } */
const sessions = new Map();
/** userId -> { fromUserId } pending incoming friend request */
const pendingFriendRequests = new Map();

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

function ensureFriendSet(userId) {
  if (!friendships.has(userId)) friendships.set(userId, new Set());
  return friendships.get(userId);
}

function publicProfile(userId) {
  const p = profiles.get(userId);
  if (!p) return null;
  return {
    id: p.userId,
    username: p.username,
    avatar: p.avatar,
    bio: p.bio,
    online: sockets.has(p.userId),
  };
}

function send(userId, type, payload = {}) {
  const ws = sockets.get(userId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

// Mode is a canonical, sorted, deduped string like "audio+text+video".
function canonicalMode(modeArr) {
  const allowed = new Set(['text', 'audio', 'video']);
  const clean = [...new Set(modeArr.filter((m) => allowed.has(m)))].sort();
  return clean.length ? clean.join('+') : null;
}

function leaveQueueIfAny(userId) {
  const modeKey = queuedAs.get(userId);
  if (!modeKey) return;
  const q = queues.get(modeKey);
  if (q) {
    const idx = q.indexOf(userId);
    if (idx !== -1) q.splice(idx, 1);
  }
  queuedAs.delete(userId);
}

function endSession(userId, { notifyPartner = true, reason = 'left' } = {}) {
  const sessionId = inSession.get(userId);
  if (!sessionId) return;
  const s = sessions.get(sessionId);
  if (!s) {
    inSession.delete(userId);
    return;
  }
  const partnerId = s.a === userId ? s.b : s.a;
  inSession.delete(s.a);
  inSession.delete(s.b);
  sessions.delete(sessionId);
  if (notifyPartner) send(partnerId, 'partner-left', { reason });
}

function tryMatch(modeKey) {
  const q = queues.get(modeKey);
  if (!q || q.length < 2) return;
  const userA = q.shift();
  const userB = q.shift();
  queuedAs.delete(userA);
  queuedAs.delete(userB);

  // A disconnected user could still be sitting in the queue array; skip them.
  if (!sockets.has(userA)) return tryMatch(modeKey);
  if (!sockets.has(userB)) {
    q.unshift(userA);
    queuedAs.set(userA, modeKey);
    return tryMatch(modeKey);
  }

  startSession(userA, userB, modeKey);
}

function startSession(userA, userB, modeKey) {
  const sessionId = newId();
  sessions.set(sessionId, { a: userA, b: userB, mode: modeKey });
  inSession.set(userA, sessionId);
  inSession.set(userB, sessionId);

  const areFriends = ensureFriendSet(userA).has(userB);

  send(userA, 'match-found', {
    sessionId,
    mode: modeKey,
    initiator: true,
    partner: areFriends ? publicProfile(userB) : { id: userB, anonymous: true },
    alreadyFriends: areFriends,
  });
  send(userB, 'match-found', {
    sessionId,
    mode: modeKey,
    initiator: false,
    partner: areFriends ? publicProfile(userA) : { id: userA, anonymous: true },
    alreadyFriends: areFriends,
  });
}

function partnerOf(userId) {
  const sessionId = inSession.get(userId);
  if (!sessionId) return null;
  const s = sessions.get(sessionId);
  if (!s) return null;
  return s.a === userId ? s.b : s.a;
}

// ---- WebSocket handling ------------------------------------------------

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // --- Registration (must happen before anything else) ---
    if (msg.type === 'register') {
      const requestedId = msg.userId && profiles.has(msg.userId) ? msg.userId : null;
      userId = requestedId || newId();

      if (!profiles.has(userId)) {
        profiles.set(userId, {
          userId,
          username: (msg.username || 'Anonymous').slice(0, 24),
          bio: '',
          avatar: msg.avatar || '🙂',
        });
      }
      sockets.set(userId, ws);
      send(userId, 'registered', { userId, profile: publicProfile(userId) });
      return;
    }

    if (!userId) return; // ignore anything before registration

    switch (msg.type) {
      case 'set-profile': {
        const p = profiles.get(userId);
        if (!p) return;
        if (typeof msg.username === 'string' && msg.username.trim()) {
          p.username = msg.username.trim().slice(0, 24);
        }
        if (typeof msg.bio === 'string') p.bio = msg.bio.slice(0, 160);
        if (typeof msg.avatar === 'string') p.avatar = msg.avatar.slice(0, 8);
        send(userId, 'profile-updated', { profile: publicProfile(userId) });
        break;
      }

      case 'find-match': {
        const modeKey = canonicalMode(Array.isArray(msg.mode) ? msg.mode : []);
        if (!modeKey) {
          send(userId, 'error', { message: 'Pick at least one way to connect.' });
          return;
        }
        if (inSession.has(userId)) return;
        leaveQueueIfAny(userId);

        if (!queues.has(modeKey)) queues.set(modeKey, []);
        queues.get(modeKey).push(userId);
        queuedAs.set(userId, modeKey);
        send(userId, 'queued', { mode: modeKey });
        tryMatch(modeKey);
        break;
      }

      case 'cancel-find': {
        leaveQueueIfAny(userId);
        send(userId, 'queue-cancelled', {});
        break;
      }

      case 'skip':
      case 'leave-session': {
        endSession(userId, { reason: msg.type === 'skip' ? 'skipped' : 'left' });
        break;
      }

      case 'chat-message': {
        const partnerId = partnerOf(userId);
        if (!partnerId || typeof msg.text !== 'string' || !msg.text.trim()) return;
        const text = msg.text.slice(0, 2000);
        send(partnerId, 'chat-message', { from: 'partner', text });
        send(userId, 'chat-message', { from: 'me', text }); // echo for multi-tab consistency
        break;
      }

      case 'webrtc-signal': {
        const partnerId = partnerOf(userId);
        if (!partnerId) return;
        send(partnerId, 'webrtc-signal', { signal: msg.signal });
        break;
      }

      case 'friend-request': {
        const partnerId = partnerOf(userId);
        if (!partnerId) return;
        if (ensureFriendSet(userId).has(partnerId)) return;
        pendingFriendRequests.set(partnerId, { fromUserId: userId });
        send(partnerId, 'friend-request-received', { from: publicProfile(userId) });
        send(userId, 'friend-request-sent', {});
        break;
      }

      case 'friend-response': {
        const pending = pendingFriendRequests.get(userId);
        if (!pending) return;
        pendingFriendRequests.delete(userId);
        const fromUserId = pending.fromUserId;
        if (msg.accept) {
          ensureFriendSet(userId).add(fromUserId);
          ensureFriendSet(fromUserId).add(userId);
          send(userId, 'friend-request-result', { accepted: true, friend: publicProfile(fromUserId) });
          send(fromUserId, 'friend-request-result', { accepted: true, friend: publicProfile(userId) });
        } else {
          send(fromUserId, 'friend-request-result', { accepted: false });
        }
        break;
      }

      case 'get-friends': {
        const list = [...ensureFriendSet(userId)]
          .map((fid) => publicProfile(fid))
          .filter(Boolean);
        send(userId, 'friends-list', { friends: list });
        break;
      }

      case 'chat-friend': {
        const friendId = msg.friendId;
        if (!friendId || !ensureFriendSet(userId).has(friendId)) return;
        if (!sockets.has(friendId)) {
          send(userId, 'error', { message: 'They\u2019re offline right now.' });
          return;
        }
        if (inSession.has(userId) || inSession.has(friendId)) {
          send(userId, 'error', { message: 'One of you is already in a chat.' });
          return;
        }
        const modeKey = canonicalMode(Array.isArray(msg.mode) ? msg.mode : ['text']);
        startSession(userId, friendId, modeKey);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!userId) return;
    leaveQueueIfAny(userId);
    endSession(userId, { reason: 'disconnected' });
    sockets.delete(userId);
  });
});

server.listen(PORT, () => {
  console.log(`QuietMeet running at http://localhost:${PORT}`);
});
