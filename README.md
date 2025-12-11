# WebRTC Go SPA

A minimal WebRTC demo built with a Go signaling server and a SolidJS single-page app. Uses Redis to track connected peers and who is currently broadcasting.

## Stack
- Go HTTP/WebSocket server (Gorilla WebSocket)
- Redis for lightweight presence state
- SolidJS + Vite frontend
- Optional TURN relay (coturn) for fallback when STUN/host fails

## Prerequisites
- Go 1.21+ (tested with recent Go releases)
- Bun for the frontend build
- Redis running and reachable (defaults to `localhost:6379`)

## Quick Start
```bash
# 1) Install frontend deps
cd frontend
npm install          # or bun install

# 2) Build the frontend assets
npm run build        # emits dist/ consumed by the Go server

# 3) Run Redis (if not already running)
redis-server &

# 4) Start the Go backend (serves the built frontend and /ws)
cd ../backend
go run main.go
```

Then open http://localhost:8080 in multiple tabs to see peers join and start/stop broadcasting.

## Configuration
Environment variables (optional):
- `ADDR` - HTTP listen address (default `:8080`)
- `REDIS_ADDR` - Redis address (default `localhost:6379`)
- `STATIC_DIR` - Path to the frontend `dist/` (default `../frontend/dist`)
- `STUN_URLS` - Comma-separated STUN URLs (default `stun:stun.l.google.com:19302`)
- `TURN_URLS` - Comma-separated TURN URLs (e.g., `turn:TURN_HOST:3478?transport=udp,turn:TURN_HOST:3478?transport=tcp`)
- `TURN_USERNAME` / `TURN_PASSWORD` - Credentials for TURN servers (if required)
- `ICE_MODE` - Optional; set to `turn-only` to drop STUN and force relay for testing fallback. Default is mixed STUN+TURN with STUN first.

`.env` files are loaded from the project root, `backend/.env`, or `../.env`.
Copy `.env.example` to `.env` and adjust TURN host/credentials to match your coturn config.
Debug ICE config at runtime with `curl http://localhost:8080/debug/ice` (shows servers and mode).

## Development
- Frontend: `npm run dev -- --host` from `frontend/` for hot reload; update `VITE_WS_URL` if the backend is on a non-default host/port.
- Backend: `go run main.go` from `backend/`. The server resets Redis presence sets on startup to avoid stale peer lists after restarts.

## TURN (coturn)
- Coturn config lives in `coturn/`. Copy `coturn/turnserver.conf.example` to `coturn/turnserver.conf` and adjust `realm`, `external-ip`, ports, and credentials.
- Start coturn:
  - Native: `turnserver -c coturn/turnserver.conf` (stop via service manager or `pkill turnserver`).
  - Docker: `cd coturn && ./run-docker.sh` (stop with `./stop-docker.sh`, container name defaults to `webrtc-coturn`).
- Ensure TURN creds match `TURN_USERNAME` / `TURN_PASSWORD` envs. When TURN is configured, the backend passes both STUN and TURN entries to the frontend via the WebSocket welcome message; ICE will try host/STUN first and fall back to TURN.
- Deployment runbook and pricing analysis live in `docs/TURN_DEPLOYMENT_GUIDE.md` and `docs/TURN_HOSTING_PRICE_ANALYSIS.md`.
