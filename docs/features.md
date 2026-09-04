# Boushun Feature Reference

Boushun 0.1.0 provides:

- A v2 inventory with separate Device, Interface, IP assignment, VIP, Network, and Service entities.
- A source-composed Current state: a later passive, TCP, or UDP run replaces only that source's observation instead of erasing other valid results; historical detail and comparison use the same as-of semantics.
- Passive Linux facts from `iproute2`, resolver configuration, DHCP leases, Kubernetes Nodes and Services, optional controller exports, and a local IEEE OUI CSV.
- Bounded Standard discovery with one ICMP echo attempt per address and per-target positive/negative evidence.
- Deep discovery with mDNS, SSDP, and read-only SNMPv3 collection of system, IF-MIB, LLDP-MIB, and BRIDGE-MIB/FDB data.
- Physical, Logical, and Services map views with confidence and layer filtering.
- Evidence-only Physical links with a separate unplaced-device tray, and an external-path-first Services view with ClusterIP-only services collapsed.
- View-specific automatic layouts and independently pinned positions for Physical, Logical, and Services views.
- Collector health, per-interface map/identity/scan controls, aggregated evidence, and arbitrary snapshot comparison.
- First-seen, last-seen, and observation counts for device identities.
- Identity review for suspicious shared-MAC/many-address groupings, conflicted confidence, non-destructive naming suggestions, and an audited recommended split action.
- Independent TCP service discovery across every usable IP in a selected range, with LAN, web, Kubernetes, and custom-only presets plus per-run custom ports.
- Independent, rate-limited UDP service discovery with safe common, IoT, and custom-only presets, protocol-aware probes, one timeout retry, and explicit `open-or-filtered` results.
- A dedicated searchable Open ports screen showing TCP and UDP results with protocol and confirmed/changed/uncertain filters; TCP is reported as no longer open and UDP as no longer confirmed without overstating timeout evidence.
- Compact confirmed-port rows in the map detail drawer for device and IP nodes, with uncertain UDP checks kept in a separate warning.
- Per-protocol scope, port coverage, observation freshness, and new/no-longer-confirmed changes only when a prior scan has the same protocol, CIDR, and port set.
- Per-device or VIP/address `/32` TCP/UDP rescans plus inventory, open-port, and target-specific CSV exports.
- Persisted TCP/UDP schedules with a 15-minute minimum interval, one-scan-at-a-time execution, and in-app notifications for newly opened ports after a comparable baseline.
- A consistent action hierarchy with persistent control boundaries, visible keyboard focus, explicit detail buttons, and responsive pointer targets that remain distinct from read-only observations.
- An actionable Physical map empty state that explains accepted link evidence and links directly to Deep scan or source configuration.
- Asynchronous scans with phase progress, status polling, and cancellation.
- A sticky global scan status showing scan type, target, phase, completed/total checks, discoveries, elapsed time, percentage, and cancellation from every screen.
- Manual device name, role, tags, merge, and IP split projections with an audit trail.
- Semantic diffs for device identity, IP assignment, services, and links; ARP state-only churn is ignored.
- Full database export, validated import preview, and confirmed reset with automatic rolling pre-change backups.
- Zoom, pan, viewport reset, node pinning, search, JSON/SVG export, and atomic local storage.
