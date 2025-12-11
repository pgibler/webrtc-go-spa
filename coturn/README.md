# coturn setup

This project expects coturn to run as a separate process. Use the sample config in `turnserver.conf.example` and keep credentials in sync with backend env vars.

## Quick start (native)
```bash
cd coturn
cp turnserver.conf.example turnserver.conf
# Edit turnserver.conf to set realm, external-ip, and user credentials
turnserver -c turnserver.conf
```
Stop with `pkill turnserver` or your service manager.

## Quick start (Docker)
```bash
cd coturn
cp turnserver.conf.example turnserver.conf
./run-docker.sh   # uses instrumentisto/coturn by default
```
Stop with `./stop-docker.sh` (defaults to container name `webrtc-coturn`).

## Ports/IP
- Default listening port: 3478 (UDP/TCP). Enable 5349 for TURN over TLS if needed.
- Set `external-ip` to `PUBLIC_IP/LOCAL_IP` when behind NAT or using multiple interfaces.

## Credentials
- Static creds from `turnserver.conf` (`user=...`) must match backend envs `TURN_USERNAME` / `TURN_PASSWORD`.
- For production, prefer long-term creds or REST-style time-limited creds issued by the backend.
