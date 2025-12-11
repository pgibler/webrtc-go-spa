# WebRTC Go SPA

A minimal WebRTC demo built with a Go signaling server and a SolidJS single-page app. Uses Redis to track connected peers and who is currently broadcasting.

## Stack
- Go HTTP/WebSocket server (Gorilla WebSocket)
- Redis for lightweight presence state
- SolidJS + Vite frontend

## Prerequisites
- Go 1.21+ (tested with recent Go releases)
- Node 18+ (or Bun) for the frontend build
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

`.env` files are loaded from the project root, `backend/.env`, or `../.env`.

## Development
- Frontend: `npm run dev -- --host` from `frontend/` for hot reload; update `VITE_WS_URL` if the backend is on a non-default host/port.
- Backend: `go run main.go` from `backend/`. The server resets Redis presence sets on startup to avoid stale peer lists after restarts.
