# Videochat WebRTC Improvement Plan

This document is an implementation-oriented backlog for improving the project’s WebRTC correctness, reliability, and security. It is written to be “agent-ingestable”: each item includes scope, concrete file touchpoints, and acceptance checks.

## Current Snapshot (What Exists Today)

- WebRTC signaling uses WebSocket fanout/forwarding with “dumb” server forwarding SDP + trickle ICE candidates:
  - Backend forwarding: `backend/pkg/webrtc/signaling/hub.go`
  - Client signaling + PC lifecycle: `frontend/packages/webrtc-core/src/index.ts`
- Client implements “perfect negotiation” (polite/impolite + rollback) and queues ICE candidates until `remoteDescription` exists.
- Backend advertises STUN/TURN via env (`STUN_URLS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_PASSWORD`, `ICE_MODE`) and sends them in the welcome message.

## Guiding Goals

1. **Connectivity**: Maximize call success across NATs and enterprise networks (TURN fallback, relay-only testing mode).
2. **Resilience**: Handle network changes without requiring page refresh (ICE restart and reconnects).
3. **Security**: Avoid easy real-world deployment foot-guns (origin checks, TURN abuse mitigations).
4. **Maintainability**: Reduce duplicated logic and tighten types so failures are easier to reason about.

## Work Items (Prioritized)

### P0 — Correctness / Connectivity

#### 1) Make `ICE_MODE=turn-only` truly “relay only”

**Problem**
- Backend “turn-only” currently only removes STUN servers, but clients still gather/use host candidates because the peer connection does not set `iceTransportPolicy: "relay"`.

**Implementation**
- Update `WebRTCClient` to apply relay-only policy when `iceMode === "turn-only"` (from welcome message).
  - File: `frontend/packages/webrtc-core/src/index.ts`
  - Introduce a helper for creating peer connections that reads current mode/config (e.g. `buildPeerConnectionConfig()`).
  - Ensure new connections created after receiving welcome use the latest policy.
  - Decide behavior for existing peer connections if welcome arrives after some PCs exist:
    - Option A (simple): close/recreate existing PCs on mode change.
    - Option B (minimal churn): leave existing PCs alone; apply to new PCs only (document that).

**Acceptance**
- With `ICE_MODE=turn-only`, `RTCPeerConnection.getStats()` shows relay candidates selected; no host/srflx candidate pair becomes selected.
- Calls succeed between two clients on restrictive networks when TURN is configured.

#### 2) Add explicit “end-of-candidates” signaling (optional but recommended)

**Problem**
- Current client only forwards `onicecandidate` when `event.candidate` exists. Some stacks benefit from explicitly signaling end-of-candidates to speed up ICE completion and reduce edge cases.

**Implementation**
- When `pc.onicecandidate` fires with `event.candidate === null`, send a `signal` message with `{ candidate: null }` (or a dedicated marker) and handle it by calling `pc.addIceCandidate(null)` on the receiver.
  - File: `frontend/packages/webrtc-core/src/index.ts`
  - Ensure it doesn’t break existing JSON parsing / server forwarding.

**Acceptance**
- No errors in console on end-of-candidates.
- Connection establishment remains successful; ICE completes promptly in typical scenarios.

### P1 — Resilience / Recovery

#### 3) ICE restart on transient failures

**Problem**
- On `"failed"` connection state, client tears down the peer immediately, which makes reconnection fragile during network changes.

**Implementation**
- Add a recovery path:
  - On `iceconnectionstatechange` or `connectionstatechange` with `"failed"`, attempt an ICE restart before removing the peer.
  - Approach:
    - Call `pc.restartIce()` (if supported).
    - Create an offer with `{ iceRestart: true }`, set local description, and send it.
  - Add a bounded retry counter and backoff per peer to avoid infinite loops.
  - File: `frontend/packages/webrtc-core/src/index.ts`

**Acceptance**
- Toggle network (e.g. switch Wi‑Fi) during a call; stream recovers without refresh in common browsers.
- No unbounded retries; eventual failure removes the peer cleanly.

#### 4) WebSocket reconnect with backoff + state resync

**Problem**
- If the signaling socket drops, the client reports disconnected but does not attempt reconnect.

**Implementation**
- Add reconnect loop with exponential backoff + jitter.
  - File: `frontend/packages/webrtc-core/src/index.ts`
  - Ensure reconnect does not leak old event handlers or old sockets.
  - On reconnect, request state (or rely on backend welcome + peer list) and renegotiate if broadcasting is enabled.

**Acceptance**
- Kill and restart the backend while a client tab stays open; client reconnects and resumes broadcasting to new peers.

### P1 — Security / Deployment Safety

#### 5) Restrict WebSocket `CheckOrigin` (or make it configurable)

**Problem**
- Server currently accepts any WebSocket origin: `CheckOrigin: return true`.

**Implementation**
- Provide a safe default and a controlled escape hatch:
  - Add `ALLOWED_ORIGINS` env (comma-separated).
  - If set, validate `Origin` header against list; otherwise default to same-host check.
  - File: `backend/pkg/webrtc/signaling/hub.go`
  - Document in README.

**Acceptance**
- Browser from a different origin cannot open `/ws` unless explicitly allowed.

#### 6) TURN credential hardening (short-lived creds)

**Problem**
- Static TURN creds are easy to leak/abuse and make you a relay for attackers.

**Implementation options**
- Option A: Implement TURN REST (time-limited HMAC-based credentials) on backend and send ephemeral creds in welcome.
- Option B: Integrate a managed TURN provider (documented), still sending short-lived creds.
  - Files: `backend/pkg/webrtc/ice/ice.go`, `backend/main.go`, protocol types (if needed)
  - Docs: `docs/TURN_DEPLOYMENT_GUIDE.md`

**Acceptance**
- TURN creds rotate (minutes/hours) and are not long-lived secrets in client sessions.

### P2 — Maintainability / Cleanup

#### 7) Consolidate stream lifecycle and room “broadcasting” semantics

**Problem**
- Stream removal logic exists in both the core client and the Solid wrapper. This duplication can cause drift.

**Implementation**
- Choose a single source of truth:
  - Prefer keeping stream lifecycle in `WebRTCClient` and making `solid-webrtc` a thin reactive adapter.
  - File: `frontend/packages/solid-webrtc/src/index.ts`
  - File: `frontend/packages/webrtc-core/src/index.ts`

**Acceptance**
- Solid wrapper has minimal logic: subscribe to events and expose signals; no duplicate stream pruning.

#### 8) Tighten signaling types (remove `any`)

**Problem**
- `SignalMessage.data: any` and `send(payload: any)` allow malformed payloads to propagate.

**Implementation**
- Define narrow union types for signaling payloads:
  - `RTCSessionDescriptionInit` for SDP messages
  - `RTCIceCandidateInit | null` for candidate messages
  - Optional app messages separated from signaling
  - File: `frontend/packages/webrtc-core/src/index.ts`

**Acceptance**
- TypeScript prevents sending malformed signaling payloads from the core library.

#### 9) Backend message validation + basic rate limiting

**Problem**
- Server forwards arbitrary `data` as long as `to` is present; a client can spam others.

**Implementation**
- Validate inbound message shape (`type`, `to`, `data` size) and apply per-connection rate limiting.
  - Files: `backend/pkg/webrtc/signaling/hub.go`, `backend/pkg/webrtc/protocol/types.go`

**Acceptance**
- Flooding signaling messages from a single client is throttled; server remains responsive.

## Testing & Verification Checklist

These checks should be runnable manually today; automated tests can be added opportunistically if the repo adds a test harness.

- **Connectivity matrix**
  - Same LAN (host candidates)
  - Different networks (srflx with STUN)
  - Restrictive NAT (relay with TURN)
- **Turn-only mode**
  - Set `ICE_MODE=turn-only` and verify selected candidates are `relay` via `chrome://webrtc-internals` / `getStats()`.
- **Glare**
  - Join two peers and trigger simultaneous renegotiation (e.g., both start broadcast quickly). Ensure no stuck negotiation.
- **Failure recovery**
  - Temporarily drop network; verify ICE restart path attempts recovery before teardown.
- **Security**
  - Attempt WebSocket connection from a different origin; verify rejection unless configured.

## “Nice to Have” (Future)

- Add optional DataChannel for chat/metadata (separate from media signaling).
- Add bandwidth controls and/or simulcast for better multi-peer scaling (depending on product direction).
- Add metrics: relay ratio, ICE failure rate, reconnect rate (helps justify TURN spend and reliability work).

