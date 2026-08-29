# QuietMeet — V1

Random-pairing chat where you choose the mode (text / audio / video, any
combination), matched only with people who chose the same thing. Add
people you connect with as friends to chat with them again anytime.

## Run it

```
npm install
npm start
```

Then open **http://localhost:3000** in two different browser tabs/windows
(or two devices on the same network) to try matching with yourself.

## What's in V1

- **Identity** — just a display name + emoji avatar, no signup. An id is
  saved in `localStorage` so refreshing keeps you as the same person.
- **Mode selection** — the ring picker on the landing page (text/audio/video,
  toggle any combination).
- **Matching** — strict: you're queued and paired with someone who picked
  the *exact same* mode combination. (Fuzzy/overlapping matching was
  discussed as a v2 idea — see below.)
- **Live session** — text chat always available; audio/video via WebRTC
  (peer-to-peer, using a public Google STUN server) when those modes are
  selected. Mute / camera-off toggles, Skip (requeue instantly), End.
- **Friending** — either side can send a friend request mid-chat; the other
  side must accept (mutual consent). Once friends, real profile (name,
  avatar, bio) is visible instead of "Stranger."
- **Friends list** — shows online status; click "Chat" to start a session
  directly with an online friend, no queue.

## Known V1 simplifications (by design, not bugs)

- **In-memory storage only** — restarting the server wipes all
  profiles/friendships. Swap in a real database before this goes further
  than a prototype.
- **Strict mode matching** — "audio+video" won't match with "audio" alone.
  Progressive escalation (start in text, offer to upgrade mid-chat) and
  overlap-based matching were both discussed as richer alternatives.
- **No moderation/reporting** — a report/block system is essential before
  any real users touch this; it's flagged as the top priority for v2.
- **Single server, no horizontal scaling** — fine for a prototype, not for
  production traffic.
- **STUN only, no TURN server** — WebRTC calls may fail to connect across
  some restrictive networks (corporate firewalls, some mobile carriers)
  without a TURN relay.

## File layout (flat, as requested)

```
server.js      Express + WebSocket backend: identity, matchmaking queue,
               WebRTC signaling relay, chat relay, friend requests.
index.html     All views (onboarding, mode select, matching, session,
               profile, friends) in one page, toggled by JS.
style.css      Visual design — calm slate/sage palette, Fraunces + Inter type.
app.js         Client logic: WebSocket handling, view routing, WebRTC
               setup, chat, friends, profile.
package.json   Dependencies (express, ws).
```
