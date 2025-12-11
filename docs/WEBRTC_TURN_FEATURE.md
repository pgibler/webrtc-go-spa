# WebRTC TURN Integration Plan (coturn)

Goal: add a TURN relay (coturn) as a separate process, expose its ICE servers to the frontend via the Go backend, and keep STUN as the preferred first hop with TURN as fallback.

## Implementation Steps
- Provision coturn
  - Install coturn or use a container image.
  - Create a `turnserver.conf` with explicit `listening-port` (e.g., `3478` UDP/TCP), optional `tls-listening-port` (e.g., `5349`), `realm`, `fingerprint`, `lt-cred-mech`, `user`/`userdb` or REST auth secret, `external-ip` (publicIP/localIP), and `listening-ip` bindings.
  - Run coturn separately from the app; avoid port conflicts with the Go server.
  - Start/stop commands (examples):
    - Native: `turnserver -c turnserver.conf` (stop with `pkill turnserver` or service manager).
    - Docker: `docker run --rm -p 3478:3478/udp -p 3478:3478/tcp -v $(pwd)/turnserver.conf:/etc/turnserver.conf instrumentisto/coturn -c /etc/turnserver.conf` (stop with `docker stop <container>`).
- Backend (Go)
  - Add env/config for ICE servers: `STUN_URLS` (comma-separated), `TURN_URLS` (comma-separated), `TURN_USERNAME`, `TURN_PASSWORD` (or REST-style key pair if moving to dynamic creds).
  - Parse ICE servers into a slice and include them in the WebSocket welcome payload.
  - Keep STUN-only fallback if TURN envs are absent; log a warning when TURN is not configured.
  - Optional: add a health/log line or endpoint to surface active ICE server config for debugging.
- Frontend (SolidJS)
  - Replace the hard-coded `iceConfig` with dynamic ICE servers from the welcome message, falling back to the current STUN default when missing.
  - Ensure every `RTCPeerConnection` uses the received config.
  - Add a small status indicator or console log showing whether TURN is configured (for verification).
- Auth strategy
  - Start with static long-term credentials (user/password) from env/config for simplicity.
  - Future enhancement: REST-style time-limited TURN credentials (HMAC over username:expiry) minted by the backend if per-session secrets are needed.
- Documentation
  - Update `README.md` with: how to install/run coturn, required ports/IPs, sample `turnserver.conf`, env variables, and start/stop commands.
  - Note that STUN and TURN are both advertised in `iceServers`; ICE will prefer host/STUN and fall back to TURN.
- Testing/verification
  - Local smoke: start coturn on the known IP/port, run the app, and confirm ICE gathering shows `relay` candidates in devtools.
  - Simulate restrictive NAT (e.g., block peer-to-peer on LAN) to ensure relay path works.
  - Confirm STUN-only mode still works when TURN envs are unset.

## Notes
- Run coturn on a public IP where possible; set `external-ip=<public>/<local>` for proper candidate rewriting.
- Keep UDP and TCP open on the TURN ports; add TLS if you need TURN over TLS/443 for strict firewalls.
- For scale or production, run coturn as stateless instances with health checks and per-region IPs; keep auth keys in the app to issue TURN creds.
