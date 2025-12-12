# Signaling library integration guide

This repository now exposes a reusable signaling hub for WebRTC. There are two primary integration patterns:

## 1) Turnkey HTTP handler
Use when you want the signaling server to own the WebSocket upgrade.

```go
import (
  "net/http"
  "webrtc-go-spa/pkg/signaling"
)

store := signaling.NewRedisPresence(redisClient, "webrtc")
hub := signaling.NewHub(store, signaling.HubOptions{
  ICEServers: []signaling.ICEServer{ /* ... */ },
  ICEMode:    "stun-turn", // default; also supports "turn-only" or "stun-only"
})

http.Handle("/ws", hub.HTTPHandler())
```

## 2) Already-upgraded WebSocket (fits the chat app)
Use when your app performs auth/guards before handing off to signaling.

```go
// Inside your existing /ws handler *after* auth and Upgrade succeeds:
conn, err := upgrader.Upgrade(w, r, nil)
if err != nil { /* ... */ }

// Build once at process startup
store := signaling.NewRedisPresence(redisClient, "webrtc")
hub := signaling.NewHub(store, signaling.HubOptions{
  ICEServers: iceServers,
  ICEMode:    iceMode,
})

// Pass a long-lived context (do NOT use r.Context() after returning from the handler)
ctx := context.Background()
userID := canonicalUUID // whatever identifier you already resolved
if err := hub.Accept(conn, signaling.ConnOptions{
  ID:      userID,
  Context: ctx,
}); err != nil {
  conn.Close()
}
```

Notes:
- `ConnOptions.ID` lets you reuse the authenticated user/connection ID from your chat hub; omit to auto-generate a UUID.
- `RedisPresence` accepts an optional key prefix so you can avoid collisions with existing Redis keys (default: `webrtc:`).
- The hub is transport-agnostic: it only requires a `*websocket.Conn` and a `PresenceStore`.

## Frontend library
- Core WebRTC + signaling logic lives in `frontend/packages/webrtc-core`.
- Solid adapter is in `frontend/packages/solid-webrtc` and is consumed by the demo app via `createWebRTC()`.
