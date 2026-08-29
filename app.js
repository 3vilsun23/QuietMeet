// QuietMeet — V1 client
// Single-page app: plain views toggled by JS, one WebSocket connection
// used for identity, matchmaking, WebRTC signaling relay, chat relay,
// and friending. No frameworks — keeps the flat file structure honest.

const AVATARS = ['🙂', '🦊', '🐧', '🐢', '🌙', '🍃', '🪐', '🧩', '🦋', '🐬', '🌊', '⭐'];

const state = {
  ws: null,
  wsOpen: false,
  userId: localStorage.getItem('qm_userId') || null,
  profile: null,
  pendingRegisterUsername: null,
  selectedModes: new Set(['text']),
  currentSession: null, // { sessionId, mode, initiator, partner, alreadyFriends }
  pc: null,
  localStream: null,
  remoteDescSet: false,
  iceQueue: [],
  micOn: true,
  camOn: true,
};

// ---------- View routing ----------

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  const el = document.getElementById('view-' + name);
  if (el) el.hidden = false;
  if (name === 'friends') requestFriends();
  if (name === 'profile') populateProfileForm();
}

document.addEventListener('click', (e) => {
  const navTarget = e.target.closest('[data-nav]');
  if (navTarget) showView(navTarget.dataset.nav);
});

// ---------- WebSocket plumbing ----------

function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}`);

  state.ws.addEventListener('open', () => {
    state.wsOpen = true;
    if (state.userId) {
      sendWs('register', { userId: state.userId });
    } else if (state.pendingRegisterUsername) {
      sendWs('register', { username: state.pendingRegisterUsername });
    }
  });

  state.ws.addEventListener('close', () => {
    state.wsOpen = false;
    setTimeout(connectSocket, 1500); // simple auto-reconnect for V1
  });

  state.ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleServerMessage(msg);
  });
}

function sendWs(type, payload = {}) {
  if (state.ws && state.wsOpen) {
    state.ws.send(JSON.stringify({ type, ...payload }));
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'registered':
      state.userId = msg.userId;
      state.profile = msg.profile;
      localStorage.setItem('qm_userId', msg.userId);
      document.getElementById('topbar-links').hidden = false;
      updateMeChip();
      showView('landing');
      break;

    case 'profile-updated':
      state.profile = msg.profile;
      updateMeChip();
      showInfoToast('Profile saved.');
      break;

    case 'queued':
      break;

    case 'queue-cancelled':
      showView('landing');
      break;

    case 'match-found':
      enterSession(msg);
      break;

    case 'partner-left':
      cleanupSession();
      showInfoToast(
        msg.reason === 'skipped' ? 'They skipped to the next chat.' : 'They left the chat.'
      );
      showView('landing');
      break;

    case 'chat-message':
      appendChatMessage(msg.from === 'me' ? 'me' : 'them', msg.text);
      break;

    case 'webrtc-signal':
      handleSignal(msg.signal);
      break;

    case 'friend-request-sent':
      setFriendButtonState('pending');
      break;

    case 'friend-request-received':
      showFriendToast(msg.from);
      break;

    case 'friend-request-result':
      if (msg.accepted) {
        setFriendButtonState('friends');
        if (msg.friend) updatePartnerDisplay(msg.friend);
        showInfoToast(msg.friend ? `You and ${msg.friend.username} are friends now.` : 'Friend request accepted.');
      } else {
        setFriendButtonState('idle');
        showInfoToast('They\u2019re not ready to add friends yet.');
      }
      break;

    case 'friends-list':
      renderFriends(msg.friends);
      break;

    case 'error':
      showInfoToast(msg.message || 'Something went wrong.');
      break;

    default:
      break;
  }
}

// ---------- Onboarding ----------

document.getElementById('onboarding-submit').addEventListener('click', submitOnboarding);
document.getElementById('onboarding-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitOnboarding();
});

function submitOnboarding() {
  const input = document.getElementById('onboarding-name');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  state.pendingRegisterUsername = name;
  if (state.wsOpen) {
    sendWs('register', { username: name });
  }
}

function updateMeChip() {
  if (!state.profile) return;
  const chip = document.getElementById('me-chip');
  chip.textContent = `${state.profile.avatar} ${state.profile.username}`;
}

// ---------- Mode rings ----------

const modeDescriptions = {
  text: 'Text only — quiet and typed.',
  audio: 'Audio only — voices, no camera.',
  video: 'Video only — seen, not heard.',
  'audio+text': 'Audio + text — talk and type.',
  'text+video': 'Video + text — seen, with captions on the side.',
  'audio+video': 'Audio + video — the full call.',
  'audio+text+video': 'Everything — talk, type, and see each other.',
};

function updateRingsUI() {
  document.querySelectorAll('.ring').forEach((btn) => {
    const on = state.selectedModes.has(btn.dataset.mode);
    btn.setAttribute('aria-pressed', String(on));
  });
  const key = [...state.selectedModes].sort().join('+');
  document.getElementById('rings-hint').textContent = modeDescriptions[key] || 'Choose at least one.';
}

document.getElementById('mode-rings').addEventListener('click', (e) => {
  const btn = e.target.closest('.ring');
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (state.selectedModes.has(mode)) {
    if (state.selectedModes.size > 1) state.selectedModes.delete(mode);
  } else {
    state.selectedModes.add(mode);
  }
  updateRingsUI();
});
updateRingsUI();

document.getElementById('find-match-btn').addEventListener('click', () => {
  sendWs('find-match', { mode: [...state.selectedModes] });
  document.getElementById('matching-mode-label').textContent =
    modeDescriptions[[...state.selectedModes].sort().join('+')] || '';
  showView('matching');
});

document.getElementById('cancel-find-btn').addEventListener('click', () => {
  sendWs('cancel-find');
});

// ---------- Session ----------

async function enterSession(payload) {
  state.currentSession = payload;
  showView('session');
  resetSessionUI(payload);

  const modes = payload.mode.split('+');
  const needsMedia = modes.includes('audio') || modes.includes('video');
  if (needsMedia) {
    await setupWebRTC(modes, payload.initiator);
  }
}

function resetSessionUI(payload) {
  document.getElementById('chat-log').innerHTML = '';
  const modes = payload.mode.split('+');
  document.getElementById('side-mode-label').textContent = payload.mode.replace(/\+/g, ' + ');

  const partner = payload.partner;
  updatePartnerDisplay(partner.anonymous ? { username: 'Stranger', avatar: '🙂' } : partner);

  const addFriendBtn = document.getElementById('add-friend-btn');
  if (payload.alreadyFriends) {
    setFriendButtonState('friends');
  } else {
    addFriendBtn.disabled = false;
    setFriendButtonState('idle');
  }

  document.getElementById('toggle-mic-btn').hidden = !modes.includes('audio');
  document.getElementById('toggle-cam-btn').hidden = !modes.includes('video');
  state.micOn = true;
  state.camOn = true;
  document.getElementById('toggle-mic-btn').textContent = 'Mute';
  document.getElementById('toggle-mic-btn').classList.remove('is-off');
  document.getElementById('toggle-cam-btn').textContent = 'Camera off';
  document.getElementById('toggle-cam-btn').classList.remove('is-off');

  const remoteVideo = document.getElementById('remote-video');
  const localVideo = document.getElementById('local-video');
  remoteVideo.classList.remove('active');
  localVideo.classList.remove('active');
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  document.getElementById('remote-empty').hidden = false;

  appendChatMessage('system', modes.includes('text')
    ? 'You\u2019re connected. Say hi.'
    : 'You\u2019re connected.');
}

function updatePartnerDisplay(p) {
  document.getElementById('partner-avatar').textContent = p.avatar || '🙂';
  document.getElementById('partner-name').textContent = p.username || 'Stranger';
  document.getElementById('side-partner-avatar').textContent = p.avatar || '🙂';
  document.getElementById('side-partner-name').textContent = p.username || 'Stranger';
}

function setFriendButtonState(mode) {
  const btn = document.getElementById('add-friend-btn');
  if (mode === 'pending') {
    btn.textContent = 'Request sent';
    btn.disabled = true;
  } else if (mode === 'friends') {
    btn.textContent = '✓ Friends';
    btn.disabled = true;
  } else {
    btn.textContent = '+ Add friend';
    btn.disabled = false;
  }
}

document.getElementById('add-friend-btn').addEventListener('click', () => {
  sendWs('friend-request');
});

// Chat

document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  sendWs('chat-message', { text });
  input.value = '';
});

function appendChatMessage(who, text) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = `chat-msg ${who}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// Skip / leave

document.getElementById('skip-btn').addEventListener('click', () => {
  sendWs('skip');
  cleanupSession();
  sendWs('find-match', { mode: [...state.selectedModes] });
  document.getElementById('matching-mode-label').textContent =
    modeDescriptions[[...state.selectedModes].sort().join('+')] || '';
  showView('matching');
});

document.getElementById('leave-btn').addEventListener('click', () => {
  sendWs('leave-session');
  cleanupSession();
  showView('landing');
});

// ---------- WebRTC ----------

async function setupWebRTC(modes, initiator) {
  state.remoteDescSet = false;
  state.iceQueue = [];

  const constraints = { audio: modes.includes('audio'), video: modes.includes('video') };
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    showInfoToast('Couldn\u2019t access mic/camera — continuing without them.');
    state.localStream = null;
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  state.pc = pc;

  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
    if (modes.includes('video')) {
      const localVideo = document.getElementById('local-video');
      localVideo.srcObject = state.localStream;
      localVideo.classList.add('active');
    }
  }

  pc.ontrack = (event) => {
    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.srcObject = event.streams[0];
    if (modes.includes('video')) {
      remoteVideo.classList.add('active');
      document.getElementById('remote-empty').hidden = true;
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWs('webrtc-signal', { signal: { kind: 'ice', candidate: event.candidate } });
    }
  };

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs('webrtc-signal', { signal: { kind: 'offer', sdp: offer } });
  }
}

async function handleSignal(signal) {
  const pc = state.pc;
  if (!pc || !signal) return;

  if (signal.kind === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    state.remoteDescSet = true;
    await drainIceQueue();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs('webrtc-signal', { signal: { kind: 'answer', sdp: answer } });
  } else if (signal.kind === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    state.remoteDescSet = true;
    await drainIceQueue();
  } else if (signal.kind === 'ice') {
    if (state.remoteDescSet) {
      try { await pc.addIceCandidate(signal.candidate); } catch { /* ignore */ }
    } else {
      state.iceQueue.push(signal.candidate);
    }
  }
}

async function drainIceQueue() {
  const pc = state.pc;
  while (state.iceQueue.length) {
    const c = state.iceQueue.shift();
    try { await pc.addIceCandidate(c); } catch { /* ignore */ }
  }
}

function cleanupSession() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  state.currentSession = null;
  state.remoteDescSet = false;
  state.iceQueue = [];
}

document.getElementById('toggle-mic-btn').addEventListener('click', () => {
  if (!state.localStream) return;
  state.micOn = !state.micOn;
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
  const btn = document.getElementById('toggle-mic-btn');
  btn.textContent = state.micOn ? 'Mute' : 'Unmute';
  btn.classList.toggle('is-off', !state.micOn);
});

document.getElementById('toggle-cam-btn').addEventListener('click', () => {
  if (!state.localStream) return;
  state.camOn = !state.camOn;
  state.localStream.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
  const btn = document.getElementById('toggle-cam-btn');
  btn.textContent = state.camOn ? 'Camera off' : 'Camera on';
  btn.classList.toggle('is-off', !state.camOn);
  document.getElementById('local-video').classList.toggle('active', state.camOn);
});

// ---------- Friend toast (incoming request) ----------

let pendingIncomingFriend = null;

function showFriendToast(fromProfile) {
  pendingIncomingFriend = fromProfile;
  document.getElementById('friend-toast-name').textContent = fromProfile.username;
  document.getElementById('friend-toast').hidden = false;
}

document.getElementById('friend-accept').addEventListener('click', () => {
  sendWs('friend-response', { accept: true });
  document.getElementById('friend-toast').hidden = true;
  if (state.currentSession) setFriendButtonState('friends');
});

document.getElementById('friend-decline').addEventListener('click', () => {
  sendWs('friend-response', { accept: false });
  document.getElementById('friend-toast').hidden = true;
});

// ---------- Info toast ----------

let infoToastTimer = null;
function showInfoToast(text) {
  const toast = document.getElementById('info-toast');
  document.getElementById('info-toast-text').textContent = text;
  toast.hidden = false;
  clearTimeout(infoToastTimer);
  infoToastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

// ---------- Profile ----------

function buildAvatarPicker() {
  const wrap = document.getElementById('avatar-picker');
  wrap.innerHTML = '';
  AVATARS.forEach((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-choice';
    btn.textContent = a;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.avatar-choice').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
    });
    wrap.appendChild(btn);
  });
}
buildAvatarPicker();

function populateProfileForm() {
  if (!state.profile) return;
  document.getElementById('profile-name').value = state.profile.username || '';
  document.getElementById('profile-bio').value = state.profile.bio || '';
  document.querySelectorAll('.avatar-choice').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.textContent === state.profile.avatar));
  });
}

document.getElementById('save-profile-btn').addEventListener('click', () => {
  const username = document.getElementById('profile-name').value.trim();
  const bio = document.getElementById('profile-bio').value.trim();
  const selectedAvatarBtn = document.querySelector('.avatar-choice[aria-pressed="true"]');
  const avatar = selectedAvatarBtn ? selectedAvatarBtn.textContent : (state.profile && state.profile.avatar);
  if (!username) { document.getElementById('profile-name').focus(); return; }
  sendWs('set-profile', { username, bio, avatar });
});

// ---------- Friends ----------

function requestFriends() {
  sendWs('get-friends');
}

function renderFriends(friends) {
  const list = document.getElementById('friends-list');
  const empty = document.getElementById('friends-empty');
  list.innerHTML = '';
  if (!friends.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  friends.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.innerHTML = `
      <span class="avatar-sm">${f.avatar}</span>
      <div class="friend-info">
        <div class="friend-name">
          <span class="status-dot ${f.online ? 'online' : ''}"></span>
          ${escapeHtml(f.username)}
        </div>
        ${f.bio ? `<div class="friend-bio">${escapeHtml(f.bio)}</div>` : ''}
      </div>
      <button class="btn btn-primary btn-sm" ${f.online ? '' : 'disabled'} data-friend-id="${f.id}">Chat</button>
    `;
    list.appendChild(row);
  });
}

document.getElementById('friends-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-friend-id]');
  if (!btn) return;
  sendWs('chat-friend', { friendId: btn.dataset.friendId, mode: [...state.selectedModes] });
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Boot ----------

connectSocket();
if (state.userId) {
  // Returning user — skip onboarding, wait for 'registered' to route to landing.
} else {
  showView('onboarding');
}
