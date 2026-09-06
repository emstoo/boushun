# Boushun Test Design

## 1. Purpose and Design Approach

This document defines tests independently from the existing test suite. It derives test coverage for Boushun 0.1.0 from the product behavior, public APIs, configuration, data model, user interface, and operational constraints. Existing test code, test cases, fixtures, mocks, and expected values are not inputs to this design.

The design is based on `README.md`, `SECURITY.md`, `package.json`, `compose.yaml`, `Dockerfile`, `config/snmp-targets.example.json`, `scripts/update-oui.sh`, and the production implementation under `src/`. Expected results are expressed as externally observable behavior, persisted-data invariants, and external-system boundaries rather than internal function placement.

The primary quality goals are:

- Never send packets to an unauthorized address or an excessively broad range.
- Do not confuse collection failure, lack of response, and a confirmed closed port.
- Preserve the latest valid observation from each source when another source produces a newer snapshot.
- Never persist partial results from a cancelled scan.
- Prevent unintended state loss or corruption during import, reset, migration, and concurrent writes.
- Never expose SNMPv3 credentials, kubeconfig material, or other secrets through APIs, evidence, errors, or logs.
- Display physical links only when supported by evidence, without presenting inference as fact.

## 2. Scope

### In scope

- IPv4/CIDR parsing, permitted ranges, and host enumeration
- Passive, Standard, and Deep network observation
- TCP and UDP service discovery
- Collection and normalization for Linux, DNS, DHCP, Kubernetes, controller exports, OUI, mDNS, SSDP, and SNMPv3
- Source-composed Current state, history, arbitrary snapshot comparison, and presence
- Inventory, identity review, manual overrides, merges, and splits
- Physical, Logical, and Services topologies, layout, and viewport behavior
- Asynchronous jobs, cancellation, mutual exclusion, schedules, and notifications
- JSON store, v1/v2 loading, export, import preview, import, reset, and backups
- HTTP APIs, CSV/JSON/SVG exports, static UI, and security headers
- Static read-only demo generation and publication from synthetic projected API fixtures without exposing the Boushun server
- Startup configuration, loopback request-host/origin restrictions, container privileges, and persistence boundaries
- Accessibility, keyboard operation, and important responsive behavior

### Normally out of scope

- IPv6 NDP, distributed probes, embedded UniFi/Omada authentication, and other features outside the current documented boundaries
- Correctness of IEEE data, Kubernetes itself, or SNMP devices themselves
- Discovery against the internet or a production LAN without explicit authorization
- Remote or multi-user publication of the Boushun server, including authentication, TLS, and proxy/firewall behavior; the generated static read-only demo is covered separately
- Pixel-perfect CSS matching; inaccessible controls, missing information, overlap, and missing focus behavior remain in scope

## 3. Priorities and Test Levels

| Priority | Definition |
|---|---|
| P0 | Can cause unauthorized scanning, secret disclosure, data corruption, false operational conclusions, or loss of a primary API |
| P1 | Can break a major feature, make history/topology/notifications inconsistent, or cause a recoverable persistence failure |
| P2 | Can degrade supporting displays, usability, compatibility, or diagnostics |

| Level | Primary purpose | External effects |
|---|---|---|
| Unit | Parsing, normalization, composition, diffs, layout, and input boundaries | None |
| Component | Collectors, store, jobs, and scheduler through replaceable boundaries | Temporary files and loopback only |
| API integration | HTTP contracts with a temporary store and fake collectors | Loopback only |
| UI/E2E | Primary browser-based user workflows | Fake APIs, static fixtures, or an isolated LAN |
| Deployment/acceptance | Privileges, persistence, static publication boundaries, and real collection on Linux or in a container | Static artifacts or explicitly authorized isolated ranges only |

P0 behavior must be covered beyond unit level at the applicable API integration or deployment boundary. Time, UUIDs, DNS, sockets, the filesystem, Kubernetes APIs, SNMP sessions, and OS commands should be controllable so routine automation is deterministic.

## 4. Test Data and Environments

### Baseline datasets

- IPv4: all three private blocks, link-local, loopback, public, network/broadcast addresses, `/24`, `/25`, `/31`, `/32`, and invalid octets/prefixes.
- Devices: scanner, gateway, switch, access point, host, Kubernetes node, host without a MAC, and a suspicious grouping with at least three IPv4 addresses sharing one MAC.
- Observations: Passive, ICMP, Deep, TCP, and UDP observations with distinct timestamps and snapshot IDs.
- Services: TCP open/closed/timeout, UDP open/closed/open-or-filtered, Kubernetes ClusterIP/LoadBalancer/NodePort, and controller services.
- Topology: LLDP, FDB, controller links, a device without link evidence, a VIP, and a default route.
- Database: empty, v1, v2, maximum snapshot count, malformed JSON, structurally invalid state, and state containing excess audit/notification entries.
- Static demo: a fixed-clock synthetic projected state with representative topology, TCP/UDP services, history, automation/database summaries, and no live credentials or LAN observations.

Do not use real credentials in test SNMP configuration or kubeconfig files. Secret non-disclosure tests may place a harmless identifying marker only in a protected fixture. The oracle is that the marker never appears in an API body, snapshot, evidence record, warning, error, or log.

### Network test isolation

- Unit and component tests replace connectors, probers, runners, APIs, and sessions. Observe destination, count, ordering, timeout, abort, and close behavior at those boundaries. Container CI additionally exercises real collection in a disconnected synthetic network namespace.
- Tests using real sockets are restricted to loopback or a dedicated network namespace/isolated LAN.
- Acceptance tests for multicast, ICMP, and SNMP require prior authorization for both the target CIDR and devices.
- Even in acceptance tests, constrain `BOUSHUN_ALLOWED_CIDRS` to the smallest range and verify that no packets are sent to public addresses through packet capture or a fake boundary.

## 5. Functional Test Design

### 5.1 IPv4 and scan boundaries

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| NET-01 | P0 | Provide valid IPv4 addresses and CIDRs | Octets, network, broadcast, first/last, and canonical values are consistent |
| NET-02 | P0 | Provide missing octets, non-digits, octets above 255, missing prefixes, or prefixes above 32 | Input is rejected before reaching any scan operation |
| NET-03 | P0 | Request a range broader than `/24` | Request is rejected as too broad and sends zero packets |
| NET-04 | P0 | Request public, loopback, or mixed private/public ranges | Anything outside private or link-local IPv4 is rejected |
| NET-05 | P0 | Request a range inside, equal to, outside, or partially overlapping an allowed CIDR; omit, empty, or malform the allowlist | Only fully contained ranges with a valid nonempty allowlist are accepted; invalid configuration sends no probes |
| NET-06 | P0 | Enumerate an ordinary subnet | Network and broadcast are excluded; each usable address appears once |
| NET-07 | P1 | Enumerate `/31` and `/32` | All addresses defined as usable by the product are returned without overflow or an infinite loop |
| NET-08 | P1 | Exclude a local address | Only the selected address is excluded; order and remaining addresses are preserved |
| NET-09 | P1 | Select a default range from multiple interfaces and policies | Only the first scan-eligible private/link-local interface becomes the default candidate |

### 5.2 Passive, Standard, and Deep collection

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| COL-01 | P0 | Start the application or run a Passive scan | Read `ip address/route/neigh`, resolver, leases, and optional APIs without starting active ICMP, port scanning, multicast discovery, or SNMP |
| COL-02 | P1 | One of address/route/neighbor collection fails | Preserve successful data, report degraded source health, and emit no secret-bearing warning |
| COL-03 | P1 | All local commands fail | Avoid an unnecessary collector crash and return diagnosable unavailable health/warnings |
| COL-04 | P1 | Supply valid interface, route, and neighbor JSON | Interface, network, gateway, device, and evidence references remain consistent |
| COL-05 | P1 | Supply FAILED/INCOMPLETE neighbors and each relevant NUD state | Failed neighbors are omitted; remaining states map correctly to online/recent/offline/unknown |
| COL-06 | P1 | Supply dnsmasq, ISC, and JSON/Kea lease formats | Normalize address, MAC, hostname, expiry, and source; isolate malformed documents as empty results |
| COL-07 | P1 | DHCP and reverse-DNS names conflict | Preserve the DHCP name and perform bounded reverse lookup only for unresolved addresses |
| COL-08 | P0 | Run a Standard scan | Send one ICMP attempt to each target except local/network/broadcast addresses and retain both positive and negative evidence |
| COL-09 | P0 | ICMP times out | Treat it as expected negative evidence, not an application failure or proof that the host is absent |
| COL-10 | P0 | Cancel Standard or Deep collection | Abort active operations and do not persist a partial snapshot |
| COL-11 | P1 | Run a Deep scan | Add mDNS, SSDP, and configured SNMPv3 to Passive/ICMP collection, with independent source health |
| COL-12 | P1 | Run Passive or Standard after a Deep scan | Mark Deep sources as not-run for the new snapshot without erasing their latest Current-state data |
| COL-13 | P1 | Load OUI CSV with quoting, duplicates, a header, and invalid rows | Load valid prefixes only and enrich only globally administered MAC addresses |
| COL-14 | P1 | Use locally administered, short, or unknown MAC addresses | Do not infer a manufacturer |

### 5.3 Kubernetes, controller, multicast, and SNMPv3

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| EXT-01 | P1 | No kubeconfig or ServiceAccount is available | Kubernetes is not-configured with empty data; overall collection continues |
| EXT-02 | P1 | Node and Service APIs both succeed | Normalize node roles/addresses/OS/architecture and service type/address/ports/NodePorts with verified evidence |
| EXT-03 | P1 | Only one Kubernetes API call succeeds | Preserve the available side and mark the source degraded |
| EXT-04 | P1 | Both API calls fail or time out | Mark the source unavailable without exposing credential or authentication material |
| EXT-05 | P0 | Abort the collector | End bounded API calls and do not persist a snapshot |
| EXT-06 | P1 | Import controller devices, links, and services | Enrich devices by MAC/address and add new entities/evidence without duplicates |
| EXT-07 | P1 | A controller file is missing, malformed, or partial | Preserve results from other files, mark the source degraded, and return a safe file-specific warning |
| EXT-08 | P0 | A controller document contains an out-of-schema secret marker | The marker never reaches a public API or evidence record; treat this as a security acceptance gate |
| EXT-09 | P1 | Receive duplicate or malformed mDNS/SSDP packets or a socket error | Deduplicate valid replies, ignore malformed packets, and close sockets at timeout or abort |
| EXT-10 | P0 | SNMP host/user/auth/priv fields are incomplete, or credential-bearing JSON is malformed | Reject invalid configuration before scanning; expose only a fixed safe error, never parser excerpts or file paths |
| EXT-11 | P1 | SNMP system/IF-MIB/LLDP/FDB reads succeed | Normalize system, interface, LLDP neighbor, bridge port, and FDB data and always close the session |
| EXT-12 | P1 | Some SNMP targets fail | Preserve successful targets, warn for failed targets, and close every session |
| EXT-13 | P0 | An SNMP error contains a key name and value | Redact the value from APIs, evidence, warnings, and logs |
| EXT-14 | P1 | Apply LLDP and FDB observations to topology | Use strong confidence for LLDP and inferred for FDB; never invent a link without a matching device |

### 5.4 TCP service discovery

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| TCP-01 | P0 | Combine a preset with single ports, ranges, duplicates, and reordered input | Validate, deduplicate, and sort ports |
| TCP-02 | P0 | Use 0, 65536, reversed ranges, non-numeric input, overlong input, or an empty custom-only preset | Reject with a client error before opening a connection |
| TCP-03 | P0 | Use 64 unique ports and then exceed the limit | Accept the limit and reject any excess before scanning |
| TCP-04 | P0 | Exercise maximum `/24` and 64-port coverage, then exceed an address or port boundary | Complete the maximum valid combination deterministically; rejected input makes zero connections |
| TCP-05 | P0 | Discover services regardless of ICMP results | Scan every usable address, including the probe host |
| TCP-06 | P1 | Simulate connect/refused/timeout/unreachable/unknown error | Distinguish open, closed, filtered-or-unreachable, unreachable, and error counts |
| TCP-07 | P1 | A connection opens | Send no application payload, close immediately, and record service, latency, and evidence |
| TCP-08 | P0 | Abort during the scan | Destroy active sockets and do not save a new snapshot |
| TCP-09 | P1 | Current state contains Kubernetes NodePorts | Add NodePorts to the Kubernetes preset without duplicates |
| TCP-10 | P1 | Concurrent workers complete out of order | Produce deterministic address/port ordering and accurate non-overflowing progress |

### 5.5 UDP service discovery

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| UDP-01 | P0 | Exercise valid, invalid, duplicate, and ranged preset/custom ports | Apply the independent 16-port UDP limit and normalize input |
| UDP-02 | P0 | Request ports 67, 68, 161, 162, 3702, or 5353 | Reject them before transmission because they belong to dedicated collectors |
| UDP-03 | P0 | Exercise maximum `/24` and 16-port coverage, then exceed an address or port boundary | Keep valid coverage within 4,096 checks; rejected input sends zero packets |
| UDP-04 | P0 | Scan DNS, NTP, NetBIOS, SSDP, CoAP, and an unknown port | Use bounded read-only protocol probes for known ports and an empty datagram for unknown ports |
| UDP-05 | P1 | Receive a valid reply, invalid-format reply, ICMP port-unreachable, or timeout | Keep state and service confidence distinct; do not confuse an open socket response with an identified service |
| UDP-06 | P0 | The first request times out and the retry responds | Retry once only and record the endpoint as open |
| UDP-07 | P0 | Both requests time out | Report open-or-filtered and do not add a confirmed inventory/topology service |
| UDP-08 | P0 | Configure a rate above the limit | Enforce an effective maximum of 50 datagrams per second |
| UDP-09 | P0 | Abort during delay, socket wait, or retry | Release timers/sockets and stop further sends and persistence |
| UDP-10 | P1 | Confirmed and uncertain endpoints coexist | Keep evidence, outcome counts, host/open/uncertain/transmission totals, and progress consistent |

### 5.6 Current state, inventory, and identity

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| INV-01 | P0 | No snapshot exists | Return empty inventory/topology without crashing the API or UI |
| INV-02 | P0 | Add Passive, ICMP, Deep, TCP, and UDP snapshots in different orders | Preserve the latest observation per source; a new scan of one kind never erases another kind |
| INV-03 | P1 | Observe one device again by ID, MAC, or address | Merge addresses/evidence/sources without duplicates and retain the higher identity confidence |
| INV-04 | P0 | Build Current state | Do not mutate raw snapshots; composition records each source snapshot and timestamp |
| INV-05 | P1 | A scanner has synthetic and real interfaces | Replace the synthetic interface with real interfaces/addresses and omit loopback from the map |
| INV-06 | P1 | Evaluate defaults for virtual and down interfaces | Apply map/identity/scan defaults independently and let explicit settings override them |
| INV-07 | P1 | Set identity=false or map=false | Disable only that contribution or visibility without changing unrelated controls |
| INV-08 | P1 | A confirmed TCP/UDP endpoint has no assignment | Create an inferred device/interface/address and service linked to confirmed evidence |
| INV-09 | P0 | Only an uncertain UDP endpoint exists | Do not create an inventory device/service or topology entity |
| INV-10 | P1 | A Kubernetes external address matches a device address | Convert it to a separate VIP and preserve the former device as an advertiser |
| INV-11 | P1 | Use ClusterIP-only, LoadBalancer, and NodePort services | Collapse internal-only services and correctly build external paths and the NodePort group |
| INV-12 | P1 | One neighbor-cache MAC groups at least three IPv4 addresses | Mark identity conflicted and generate a review issue with keep/move guidance |
| INV-13 | P1 | Identity is address-only | Provide an informational issue and suggested name without claiming strong identity |
| INV-14 | P1 | Save manual name, role, and tags | Change only the projection, preserve raw observations, and append an audit record |
| INV-15 | P1 | Merge 2 to 20 devices | Move device, interface, assignment, and advertiser references consistently to the target |
| INV-16 | P1 | Apply a manual or recommended split | Move only selected addresses to the new device/interface and keep source/audit state consistent |
| INV-17 | P1 | Submit an invalid merge/split or request an unavailable recommendation | Reject without changing state or audit records |

### 5.7 Topology, diffs, history, and layout

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| TOP-01 | P0 | Build the Physical view | Place only devices with explicit evidence links and put all others in the unplaced tray |
| TOP-02 | P1 | Calculate physical coverage | placed/total/percent match visible entities and remain valid for zero devices |
| TOP-03 | P1 | Build the Logical view | Correctly create network membership, VIP, advertiser, default-route, and Internet relationships |
| TOP-04 | P1 | Build the Services view | Show external device/VIP/service paths and collapse ClusterIP-only services |
| TOP-05 | P1 | Supply duplicate nodes/links or links with missing endpoints | Deduplicate by ID and remove links whose endpoints are absent |
| TOP-06 | P1 | Apply confidence, layer, and view filters | Show only matching items without changing the meaning of legends, counts, or details |
| TOP-07 | P1 | Change device identity/address/service/link across snapshots | Emit meaningful added/removed/changed events while ignoring ARP state-only churn |
| TOP-08 | P0 | Select a TCP/UDP comparison baseline | Use only an earlier scan with the same protocol, CIDR, and port set; when none exists, mark the observation as a baseline with no added or removed endpoints |
| TOP-09 | P0 | A formerly confirmed UDP endpoint is now uncertain | Report lost confirmation/uncertain, never confirmed closed |
| TOP-10 | P1 | Compare arbitrary from/to snapshots | Compose each side as of its selected point and return not-found for missing IDs |
| TOP-11 | P1 | Calculate presence over all history | first seen, last seen, observation count, and currently observed match the timeline |
| TOP-12 | P1 | Compute automatic layout for all three views | Follow view-specific ranks/connections and give every node finite coordinates |
| TOP-13 | P1 | Load view-specific and legacy pins | Prefer view-specific pins and preserve independent positions after reload |
| TOP-14 | P1 | Save fractional, negative, over-20000, NaN, or invalid-ID positions | Keep only valid positions, round them, and clamp them to the supported range |
| TOP-15 | P2 | Zoom, pan, convert coordinates, and hit limits | Preserve the pointer center, clamp scale to 0.35–4, and restore defaults on reset |
| TOP-16 | P1 | Load the built-in demo without external collection | Produce an internally consistent state with valid evidence references, evidence-backed physical links, a logical Internet path, and representative confidence levels in every topology view |

### 5.8 Asynchronous jobs, schedules, and notifications

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| JOB-01 | P0 | Start a scan | Return 202 and a job ID; transition queued→running→completed with times and result snapshot ID |
| JOB-02 | P0 | Start another scan while one is active | Return conflict with the active job and do not start a second scan |
| JOB-03 | P0 | Cancel a queued or running job | Transition cancelling→cancelled without an error or partial snapshot |
| JOB-04 | P1 | Poll/cancel completed, failed, cancelled, and unknown jobs | Preserve terminal state and return not-found for an unknown job |
| JOB-05 | P1 | Submit malformed or oversized progress, metrics, or errors | Sanitize counts, percent, lengths, keys, and numeric values; expose no internal object |
| JOB-06 | P1 | Exceed job retention | Retain active jobs while removing older terminal jobs |
| SCH-01 | P0 | Create or update a schedule | Validate protocol, CIDR, preset, ports, and 15–10080 minutes; persist next run and audit |
| SCH-02 | P1 | Reach and exceed 10 schedules, then delete one | Enforce the limit; deleting a schedule never deletes observations |
| SCH-03 | P1 | Multiple schedules are due | Run one at a time in nextRunAt order and prevent duplicate execution from reentrant ticks |
| SCH-04 | P1 | A due schedule conflicts with an active scan | Mark it skipped and retain its next time and diagnostic state |
| SCH-05 | P1 | A scheduled scan succeeds, fails, or is cancelled | Keep runtime status, lastRunAt, nextRunAt, and bounded error text consistent |
| SCH-06 | P1 | A new port appears after a comparable baseline | Create one unread notification tied to the schedule |
| SCH-07 | P1 | Baseline differs, the port already existed, or fingerprint repeats | Do not create a notification or duplicate it |
| SCH-08 | P1 | Mark selected/all notifications read and exceed retention | Set readAt only on selected items and retain the latest 200 entries |

### 5.9 Store, database, and backups

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| DB-01 | P0 | Initialize an empty data location | Create a 0700 data directory and 0600 version-2 state file |
| DB-02 | P0 | Initialize existing state | Preserve content and correct state-file permissions to 0600 |
| DB-03 | P0 | Submit concurrent writes | Serialize them without lost updates, partial JSON, or temporary-file collision |
| DB-04 | P0 | Save more snapshots than retained | Keep the latest 50 in order |
| DB-05 | P1 | Read v1 state | Normalize to the v2 read model and safely write version 2 on the next mutation |
| DB-06 | P0 | Export the database | Include format, schema, exportedAt, and complete state in a re-importable document |
| DB-07 | P0 | Preview import of wrapper/raw-v1/raw-v2 data | Validate and summarize without modifying state or creating a backup |
| DB-08 | P0 | Import malformed JSON, non-object data, unknown versions, bad types, or excess snapshots | Reject and preserve existing state |
| DB-09 | P0 | Send an import body over 25 MiB | Reject without adopting the body or changing state |
| DB-10 | P0 | Use incorrect confirmation or import/reset during an active scan | Reject without changing backup or state |
| DB-11 | P0 | Import or reset successfully | Write a complete 0600 pre-change backup, then replace state atomically |
| DB-12 | P0 | Inject a filesystem failure during backup or primary write | Keep existing state readable and do not report success |
| DB-13 | P1 | Repeat imports/resets | Create operation-specific backups and retain only the latest five |
| DB-14 | P1 | Reset the database | Clear Boushun state only; preserve OUI, kubeconfig, controller, and SNMP source files |
| DB-15 | P1 | Read excess audit, notification, and schedule entries | Normalize to the supported limits and isolate invalid entries |

### 5.10 HTTP API, exports, and security

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| API-01 | P0 | Request `/api/health` and `/api/state` | Return consistent status, active scan, Current projection, topologies, source health, presence, and settings |
| API-02 | P1 | List/view/compare history | Return summaries and as-of projections; missing IDs return not-found |
| API-03 | P1 | Exercise valid/invalid methods, paths, and bodies for every mutation endpoint | Return documented status/error JSON and perform no unintended mutation |
| API-04 | P0 | Send malformed JSON or a normal API body over 64 KiB | Return a client error while keeping the process and state healthy |
| API-05 | P0 | Store/collector returns ENOENT, EACCES, EPERM, or a long error | Suppress sensitive paths/details and return bounded safe error text |
| API-06 | P0 | Request API, static, not-found, and error responses | Always apply nosniff, frame denial, no-referrer, and strict CSP headers |
| API-07 | P0 | Bind to loopback and non-loopback addresses | Loopback starts normally; every non-loopback address is rejected before the store or collector is initialized |
| API-08 | P0 | Download every export type | Use appropriate cache control, content type, content disposition, and filename |
| API-09 | P0 | Export CSV containing commas, quotes, newlines, or leading `= + - @` | Quote safely, mitigate formula injection, and include a UTF-8 BOM |
| API-10 | P1 | Export inventory, ports, and a selected target | Columns and protocol/state/change/coverage/device meanings match the UI |
| API-11 | P0 | Place credential markers in SNMP/kubeconfig/source fixtures | No marker appears in state, exports, errors, CSV, or UI |
| API-12 | P1 | Request root/JS/CSS and unknown/traversal paths | Return correct MIME/cache behavior, JSON not-found for unknown paths, and no traversal |
| API-13 | P0 | Send an unknown/malformed Host, a cross-origin browser request, a same-origin request, and an Origin-less local request | Reject the unknown or malformed Host before routing, reject cross-origin requests before mutation, and accept same-origin or non-browser local clients |

### 5.11 UI and user workflows

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| UI-01 | P1 | Load initial, empty-database, normal, and demo states | Correctly switch loading, empty, recovery, demo, and Current-state summaries |
| UI-02 | P1 | Navigate through every sidebar screen | Topology, Open ports, Inventory, Evidence, Sources, History, Automation, and Database do not overlap |
| UI-03 | P1 | Select profile/CIDR in the scan dialog | Offer only allowed candidates and show global status after starting |
| UI-04 | P0 | Poll, cancel, or reload during a scan | Restore scan kind, target, phase, counts, result, elapsed time, percent, and cancellation |
| UI-05 | P1 | Edit TCP/UDP preset and custom ports | Preview target/port counts consistently with server validation and block unsafe/excess input |
| UI-06 | P1 | Search/filter Open ports by protocol/state | Keep confirmed, no-longer-open/confirmed, and uncertain meanings distinct |
| UI-07 | P0 | Display a UDP timeout | Never mix it with confirmed open topology, display, or counts |
| UI-08 | P1 | Change map view/layer/confidence/search | Synchronize graph, legend, caption, empty state, and unplaced/group companion; label every node status in a shared legend without relying on color alone |
| UI-09 | P1 | Open nodes/links with pointer and keyboard | Reach the same details/evidence/actions and allow the detail view to close |
| UI-10 | P1 | Drag nodes, pan, zoom by wheel/buttons, and reset | Avoid accidental clicks and keep pinning separate from viewport movement |
| UI-11 | P1 | Override, merge, split, or apply a recommended split | Refresh projection and audit after confirmation while preserving raw evidence |
| UI-12 | P1 | Run target `/32` TCP/UDP rescans and target CSV export | Limit operation to the selected device/VIP/address without broadening to the network |
| UI-13 | P1 | Toggle map/identity/scan policy for an interface | Reflect saved controls in candidates, inventory, and map according to each policy |
| UI-14 | P1 | Compare arbitrary history entries | Associate semantic events with the selected snapshot metadata |
| UI-15 | P0 | Preview→IMPORT, RESET, and database failure paths | Preview is non-mutating; confirmation and active-scan gates are explicit; failures remain recoverable |
| UI-16 | P1 | Create/update/delete/run/toggle schedules and read notifications | Keep API state, badges, and lists synchronized without double submission |
| UI-17 | P2 | Use keyboard-only navigation, focus indicators, and screen-reader names | Reach every action; icons, dialogs, progress, and status expose identifiable name/role/state; persistent focus and control boundaries meet the project's 3:1 contrast threshold and control text meets 4.5:1 |
| UI-18 | P2 | Use narrow viewports, touch, and high zoom | Prevent control overlap or content loss, keep interactive controls distinguishable from static content, and provide pointer targets at least 40 CSS pixels high |
| UI-19 | P1 | API times out, returns 4xx/5xx, or polling stops | Show a safe toast/banner and restore buttons/loading to a usable state |
| UI-20 | P1 | Export JSON, SVG, and CSV | Preserve the selected/current meaning and never execute user-controlled content as script |
| UI-21 | P1 | Build and load the static demo at a site root and below a subpath | Assets resolve through relative URLs, the synthetic projected state/history/service data render without a live Boushun backend, and every sidebar view remains usable |
| UI-22 | P0 | Attempt scan, identity, schedule, notification, or database mutations in the static demo | Mutating controls remain unavailable and non-GET API requests are rejected locally, while search, view/filter changes, pan/zoom, node inspection, layout dragging, and client-side exports remain usable |

### 5.12 Deployment and operational boundaries

| ID | Priority | Condition or action | Expected result |
|---|---:|---|---|
| DEP-01 | P0 | Start the standard container | Run non-root with a read-only root filesystem, no-new-privileges, all capabilities dropped except NET_RAW |
| DEP-02 | P0 | Use the persistent volume and tmpfs | Persist state/OUI under `/data` without requiring root-filesystem writes |
| DEP-03 | P1 | Exercise the health check | Check loopback `/api/health` on the configured port and mark non-2xx/connection failure unhealthy |
| DEP-04 | P0 | Omit or narrow `BOUSHUN_ALLOWED_CIDRS` | Compose rejects omission and runtime rejects scans outside the configured scope |
| DEP-05 | P0 | Mount SNMP/kubeconfig/controller/lease inputs | Read only explicitly mounted files and include no credential in the image or database export |
| DEP-06 | P1 | Send SIGINT/SIGTERM | Stop accepting new work, stop the scheduler, and exit within a bounded interval |
| DEP-07 | P1 | OUI update succeeds, HTTP fails, or download is empty | Replace the 0600 destination only on success and preserve an existing file on failure |
| DEP-08 | P0 | Generate and publish `dist/demo/` | Build from synthetic projected API responses only; emit static assets/fixtures with no live collector or server dependency, preserve subpath hosting, and never require relaxing loopback/Host/Origin protections in the production server |

## 6. Cross-Cutting Invariants

Every scenario should also verify these invariants where applicable:

1. Every inventory entity, link endpoint, and evidence reference points to an existing ID.
2. Projection, override, comparison, and rendering never mutate raw snapshots.
3. With a fixed clock and input, normalized results are deterministic except for UUIDs and generated timestamps.
4. Source states for not configured, not run, connected, degraded, and unavailable remain distinct.
5. Negative evidence remains distinct from collector failure.
6. TCP timeout means filtered-or-unreachable; UDP timeout means open-or-filtered; neither is confirmed closed.
7. Partial snapshots from cancelled/failed jobs are not published as Current, and a completed job's result snapshot ID references a saved snapshot.
8. A successful mutation has matching persisted state, audit, and API response; a failed mutation adds none of them.
9. User-controlled text is never interpreted as HTML and is mitigated as spreadsheet formula input in CSV.
10. Credential sources are input-only and never enter the public data model.
11. Publishing the static demo never relaxes the production server's loopback, Host, or Origin boundaries; the published artifact remains synthetic and read-only.

## 7. Non-Functional and Fault-Injection Coverage

### Performance and resources

- At `/24` with the maximum port count for each protocol, attempt totals and progress match the limits without blocking the event loop for an excessive interval.
- `/api/state` and exports remain practical with 50 snapshots, 500 audit entries, 200 notifications, and all topology views.
- TCP concurrency and UDP concurrency/pacing do not leak sockets, timers, or listeners.
- Search, filtering, drag, and zoom remain usable with a large inventory/topology.

### Fault injection

- Filesystem: failures at read, temporary write, rename, chmod, and backup cleanup.
- External sources: timeout, partial response, malformed JSON/packet, permission denial, and DNS failure.
- Network: refused, unreachable, timeout, late response, and abort/response races.
- Process: shutdown during a scan and request contention during database mutation.
- Browser: delayed API responses, polling failure, reload, download failure, repeated clicks, and missing or malformed static-demo fixtures.

After each injected failure, verify that the process remains responsive, `state.json` is parseable, prior snapshots remain, active flags are released, sockets/timers/sessions terminate, and no secret is exposed. Static-demo fixture failures must fail closed without falling through to a live Boushun API.

## 8. Execution Order and Release Gates

The public CI gate runs three independent jobs:

1. `npm run check` on every supported Node.js release line for syntax, unit, component, store, and loopback API tests. This includes a fixed-clock static-demo build test that captures projected synthetic API responses, verifies representative TCP/UDP and history data, checks subpath-safe assets, and asserts the read-only fixture contract.
2. `npm run test:e2e` in Chromium against a fixed-clock synthetic snapshot, followed by `npm run screenshots` and `npm run verify:screenshots` to validate generated PNG dimensions and reject textual metadata without requiring a real LAN. Exact image bytes are not compared across operating systems because browser rendering and fonts vary by runner.
3. `npm run test:container` builds the production image and validates the production Compose host-network configuration. Runtime checks share a disconnected synthetic fixture's network namespace: passive collection must discover its dummy interface, ICMP must succeed, and a TCP scan must find its service. The application retains its non-root user, read-only root filesystem, `NET_RAW`-only capability boundary, health check, persistent volume, and restricted temporary filesystem. Writes to the root filesystem and execution from `/tmp` must actually fail. Recreating the application container must preserve exported state and layout. Only the isolated fixture receives `NET_ADMIN` to create the dummy interface; neither container can reach the host LAN. The script ignores local overrides and `.env`, refuses an existing `boushun-ci` project or data volume, and removes its synthetic containers and volume on completion or test failure.

CodeQL default setup runs independently of these jobs. The default branch also has an active code-scanning ruleset requiring CodeQL results, with `errors` and `high_or_higher` alert thresholds; its intended configuration is tracked in [the ruleset file](../.github/code-scanning-ruleset.json). The file alone does not activate GitHub enforcement. Existing functional checks and the no-bypass policy remain required.

Real host-LAN behavior, UDP, multicast, SNMP, and external Kubernetes/controller acceptance is intentionally excluded from public CI. Run those checks only in an explicitly authorized isolated Linux environment and record the scope and result for the release. The synthetic container checks do not prove compatibility with those external integrations.

Progression requires all P0 tests to pass. A P1 failure must be explicitly accepted with cause, impact, and workaround. Any unexplained timeout, partial failure, data discrepancy, resource leak, or credential-marker appearance blocks progression. A timeout that passes on retry is not accepted until its cause is understood.

## 9. Completion Criteria

- Every P0/P1 case maps to at least one automated test or explicit acceptance procedure.
- Every active-scan entry point verifies pre-send validation and observes actual destination/count.
- Recovery paths are covered for cancellation, mutual exclusion, import/reset failure, and atomic-write failure.
- Current state, history detail, and arbitrary comparison use the same as-of semantics.
- UDP uncertainty, Physical unplaced devices, ClusterIP collapse, and identity conflicts retain their meaning in both UI and API.
- Credential markers never appear in APIs, exports, evidence, warnings, errors, logs, or UI.
- The static demo is reproducibly generated from synthetic projected data, remains read-only without a live backend, and can be hosted from a subpath without weakening production server boundaries.
- Test results record the execution environment, fixture provenance, authorized network scope, and remaining known limitations.