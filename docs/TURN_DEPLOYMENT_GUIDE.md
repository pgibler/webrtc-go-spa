# TURN Server Deployment Guide (coturn)

This is a concise checklist to spin up coturn on a new node and wire it into the app.

## 1) Provision the Server
- Pick a provider/region close to your users (IPv4 required). For tests, a small shared VM is fine; for production, prefer a 10 Gbps NIC if you expect multi-Gbps relay.
- Open firewall/SG rules: allow UDP 3478, TCP 3478 (and TCP 5349 if using TLS), plus SSH 22.
- Optional: enable IPv6 only if you plan to advertise it in TURN_URLS.

## 2) Install coturn (Ubuntu/Debian)
```bash
apt-get update && apt-get install -y coturn
systemctl enable coturn   # start on boot
```
Ensure `/etc/default/coturn` (or distro equivalent) has `TURNSERVER_ENABLED=1` if present.

## 3) Configure `/etc/turnserver.conf`
Minimal template (adjust host/IP/creds):
```
listening-port=3478
#tls-listening-port=5349          # enable if using TURN over TLS/443
#listening-ip=<bind-ip>            # optional
external-ip=<public-ip>[/<private-ip>]  # include private IP if behind NAT
realm=webrtc-go-spa
fingerprint
lt-cred-mech
user=demo:demo123                 # keep in sync with app env TURN_USERNAME/PASSWORD
#verbose                          # uncomment for troubleshooting
#cert=/etc/ssl/certs/turn.pem     # if enabling TLS
#pkey=/etc/ssl/private/turn.key
```

## 4) Restart and Verify
```bash
systemctl restart coturn
systemctl status coturn
journalctl -u coturn -f           # check for errors
ss -lunp | grep 3478              # confirm listening on UDP 3478
```
Check firewalls: allow UDP 3478 (and TCP 3478/5349).

## 5) Connectivity Checks (from your machine)
- TCP: `telnet <turn-ip> 3478`
- UDP: `sudo nmap -Pn -sU -p 3478 <turn-ip>` (ensure firewall allows UDP)
- TLS (if enabled): `openssl s_client -connect <turn-ip>:5349`

## 6) Wire Into the App
In your backend `.env` (or `backend/.env`), set:
```
TURN_URLS=turn:<turn-ip>:3478?transport=udp,turn:<turn-ip>:3478?transport=tcp
TURN_USERNAME=demo
TURN_PASSWORD=demo123
# Optional ICE modes (default is stun-turn for STUN+TURN):
#ICE_MODE=turn-only
#ICE_MODE=stun-only
#ICE_MODE=stun-turn
# If TLS enabled:
#TURN_URLS=turn:<turn-ip>:3478?transport=udp,turn:<turn-ip>:3478?transport=tcp,turns:<turn-ip>:5349?transport=tcp
```
Restart the Go backend and hit `/debug/ice` to confirm the TURN URLs and mode.

## 7) Test WebRTC
- Open the app in two browsers (ideally different networks), set `ICE_MODE=turn-only` temporarily, and confirm `relay` candidates appear and calls connect.
- For STUN-only checks (no TURN fallback), set `ICE_MODE=stun-only` and verify only host/STUN candidates show up.
- Use `ICE_MODE=stun-turn` or remove the env var to return to STUN+TURN for normal use.

## 8) Ops Notes
- Keep TURN creds in sync with `user=` in `turnserver.conf` and app env.
- Monitor bandwidth and latency; scale out before saturating the NIC (~60–70% sustained).
- Run multiple nodes per region for redundancy; load-balance with DNS/health checks.
- For TLS on 5349/443, add valid certs and open the port; useful behind strict firewalls.
