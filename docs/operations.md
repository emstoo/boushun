# Boushun Operations

## Scan profiles and safety

`passive` reads host facts and local APIs only. `standard` validates a private/link-local CIDR, rejects anything larger than `/24`, excludes network/broadcast/local addresses, sends one ICMP echo attempt to each remaining address, refreshes the neighbor cache, and runs bounded reverse DNS. `deep` adds a short mDNS/SSDP multicast window and configured SNMPv3 targets.

TCP service discovery is a separate operation. It checks every usable address in the selected range regardless of ICMP response, including the probe host, using ordinary TCP connections that are closed immediately without an application payload. Network and broadcast addresses are excluded. A run is limited to 64 unique ports and 16,384 connection attempts. Presets can be extended with comma-separated ports or bounded ranges such as `8123,9000-9003`.

UDP service discovery is also independent and checks every usable address. Known ports use bounded, read-only DNS, NTP, NetBIOS, SSDP, or CoAP probes; other custom ports receive an empty datagram. A run is limited to 16 unique ports and 4,096 address-port checks, paced to at most 50 datagrams per second with one retry after a timeout. A UDP response is `open`; a port-unreachable error is `closed`; no response after both probes is `open-or-filtered`. Only confirmed replies become inventory or topology services.

No passive, standard, or deep profile scans ports. Service discovery does not send banners, try login credentials, or change a remote device. SNMPv3 remains limited to configured targets, while mDNS and WS-Discovery-style multicast belong to discovery collectors rather than range-wide UDP probing. A cancelled job closes active sockets and does not persist a partial snapshot.

## Storage and recovery

`data/state.json` is written atomically with mode `0600`; the directory is `0700`, and the latest 50 raw snapshots are retained. A v1 file is projected and rewritten as v2 on the next mutation. Current-state composition is a read model over those append-only snapshots, so upgrading does not rewrite existing observations. Overrides never rewrite raw observations and each edit appends an actor, time, action, before/after record, up to 500 records.

The Database screen exports the complete state file in a versioned Boushun wrapper. Import accepts a raw v1/v2 state or the current wrapper. It validates the document without mutation first and has a 25 MiB request limit. Import and reset are rejected while a scan is active. Before either replacement, Boushun writes a mode `0600` backup beside `state.json` and retains the five newest `state.backup.*.json` files. Reset affects only Boushun state; `oui.csv`, kubeconfig, controller exports, and SNMP target or credential files remain untouched.

## Container image maintenance

The Docker base image is pinned to the verified multi-platform digest of the official `node:22-bookworm-slim` image. Review and update the tag and digest together when adopting a patched base image.
