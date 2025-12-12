# TURN Hosting Price Analysis

Assumptions (keep consistent when comparing):
- Bitrate: assume ~1 Mbps each way per user (low/medium quality). At 2 Mbps, costs roughly double; at 500 kbps, they roughly halve.
- Traffic pattern: relayed media at ~1 Mbps each way per user → ~0.9 GB/hour of TURN data (ingress+egress at the relay).
- Usage: 10 hours of TURN-relayed usage per user per month (light-to-moderate). Annualized data:  
  - 10k users → ~90 TB/month → ~1.08 PB/year  
  - 100k users → ~900 TB/month → ~10.8 PB/year  
  - 1M users → ~9 PB/month → ~108 PB/year
- All traffic assumed to relay through TURN (worst-case, no P2P host/STUN success).
- Hybrid note: real-world TURN often sees 5–30% relay ratio if host/STUN succeeds. Multiply the worst-case cost by your observed relay ratio to estimate real spend.

## Cost Snapshots (per year, under the above usage)

| Provider/Model              | 10k users (~1.08 PB/yr) | 100k users (~10.8 PB/yr) | 1M users (~108 PB/yr) | Notes |
|-----------------------------|-------------------------|--------------------------|-----------------------|-------|
| Twilio NTS (TURN only)      | ~$432k                  | ~$4.32M                  | ~$43.2M               | ~$0.40/GB; no infra ops; ideal for low-volume or burst fallback, expensive at scale. |
| AWS egress (DIY coturn)     | ~$97k                   | ~$972k                   | ~$9.72M               | Assumes $0.09/GB egress; compute negligible vs. bandwidth; great ops, high egress cost. |
| DigitalOcean/Vultr (DIY)    | ~$12k                   | ~$120k                   | ~$1.2M                | Assumes ~$10/TB egress; modest VM costs; use multiple regions/VMs with UDP open. |
| Hetzner/OVH dedicated (DIY) | ~$4.2k                  | ~$42k                    | ~$420k                | Assumes ~$1/TB over 20 TB included per box; 10 Gbps NIC options; lowest bandwidth cost; more ops. |

## What to Choose When
- **Small/low-duty or burst fallback:** Twilio NTS—zero ops, pay-per-GB; cost scales linearly and quickly.
- **Cloud convenience, moderate scale:** DigitalOcean/Vultr high-bandwidth plans—cheap egress vs. hyperscalers, run multiple coturn nodes per region.
- **Enterprise features, but pricey bandwidth:** AWS/GCP/Azure—only if you need their ecosystem and can afford egress.
- **Large scale/cost-sensitive:** Hetzner/OVH dedicated with 10 Gbps—best $/TB; deploy multiple boxes per region, DNS load-balance, and monitor bandwidth/headroom.

## Deployment Guidance
- Run multiple TURN nodes per region; set `external-ip` correctly; open UDP/TCP 3478 (and 5349 for TLS/443).
- Use long-term or REST credentials; rotate secrets; health-check nodes and drain gracefully.
- Monitor relay rates: if many sessions succeed with host/STUN, actual TURN cost drops below these worst-case numbers.
- Plan for redundancy: at least 2–3 nodes per region; scale out when sustained relay approaches ~60–70% of link capacity.

## Hybrid STUN-First Planning
- Measure relay ratio: instrument TURN vs host/STUN success (e.g., via metrics on candidate types or TURN auth hits). Typical public-internet apps see 5–30% TURN usage; enterprise firewalled scenarios can be higher.
- Cost scaling: effective cost ≈ worst-case cost × relay_ratio. Example at 10% relay for 10k users:  
  - Twilio: ~$43.2k/yr instead of ~$432k  
  - AWS DIY: ~$9.7k/yr instead of ~$97k  
  - DO/Vultr DIY: ~$1.2k/yr instead of ~$12k  
  - Hetzner/OVH DIY: ~$420/yr instead of ~$4.2k
- Capacity planning: size TURN nodes for peak relay traffic, not total sessions. If 10% relay at 10k users, peak throughput target is ~1–2 Gbps, not 10–20 Gbps.
- Fallback strategy: keep `ICE_MODE` or equivalent to force TURN-only during tests to validate relay path or `stun-only` to validate host/STUN paths without relay; return to the default `stun-turn` (both) for production efficiency.

## 1-to-Many Broadcasting Cost Estimates
- Assumptions: one broadcaster sends ~2 Mbps (supports 1080p for many scenes, some 720p for higher motion); audience receives ~2 Mbps each; TURN counts ingress+egress. Per-hour data ≈ 0.9 GB × (viewers + 1). Usage: 10 broadcast hours/month (same cadence as above).
- Annual data volume:
  - 10k viewers: ~9 TB/hour → ~90 TB/month → ~1.08 PB/year
  - 100k viewers: ~90 TB/hour → ~900 TB/month → ~10.8 PB/year
  - 1M viewers: ~900 TB/hour → ~9 PB/month → ~108 PB/year
- Yearly cost (worst-case all via TURN at 2 Mbps):
  - Twilio:  
    - 10k viewers: ~$432k/yr  
    - 100k viewers: ~$4.32M/yr  
    - 1M viewers: ~$43.2M/yr
  - AWS DIY (0.09/GB egress):  
    - 10k viewers: ~$97k/yr  
    - 100k viewers: ~$972k/yr  
    - 1M viewers: ~$9.72M/yr
  - DO/Vultr DIY (~$10/TB):  
    - 10k viewers: ~$12k/yr  
    - 100k viewers: ~$120k/yr  
    - 1M viewers: ~$1.2M/yr
  - Hetzner/OVH DIY (~$1/TB):  
    - 10k viewers: ~$1.2k/yr  
    - 100k viewers: ~$12k/yr  
    - 1M viewers: ~$120k/yr
- Notes: Costs scale linearly with bitrate and viewer hours. Real-world broadcast may still get some host/STUN hits; apply relay ratios to adjust.

## Hetzner vs. OVH Notes
- Why they’re cheap: lean, no-frills infrastructure with generous included bandwidth and low margins; fewer managed services than hyperscalers.
- Regions: Hetzner is primarily DE/FI + US East. OVH has broader spread (EU, UK, Canada, US). Pick closest to your users.
- DDoS: OVH includes always-on DDoS protection. Hetzner is more bare-bones; consider upstream mitigation if needed.
- Ops/support: basic ticket support; you own monitoring, backups, and failover. Provision multiple nodes per region for resilience.
- Networking/load balancing: no built-in anycast/L7 LB; use DNS/load balancer and health checks yourself. Set `external-ip` per node and open UDP/TCP 3478 (5349 for TLS/443).
- Compliance/reputation: you handle security/compliance. Some IP ranges have tighter filtering for email (not an issue for TURN).
- Instance guidance:
  - Hetzner: for tests, CPX31/CPX41 (VPS) are fine; for production, use AX/EX with 10 Gbps add-on (e.g., AX41-NVMe or larger) in the closest DC (NBG/FSN/HEL/ASH). Prioritize NIC and bandwidth; 32–64 GB RAM and NVMe are ample.
  - OVH: for tests, VPS Comfort/Elite if a 2 Gbps NIC suffices; for production, Advance/Scale dedicated with 10 Gbps (or 1–2 Gbps if enough) in the nearest region (RBX/GRA/UK/CA/US). DDoS filtering included.
