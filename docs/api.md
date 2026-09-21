# Boushun HTTP API

This reference describes the loopback-only Node.js server, including the local synthetic demo server. The public static demo exposes none of these HTTP endpoints: its browser runtime reads a generated fixture and static export files, rejects API mutations locally, and never falls back to a Boushun server. Captured route keys are an internal fixture contract, not a public HTTP API. See [static-demo operations](operations.md#static-demo-build-and-publication) and the [security boundary](../SECURITY.md#static-demo-publication).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health and active scan |
| `GET` | `/api/state` | Latest v2 inventory, all topologies, source health, presence, settings, semantic diff, layout, overrides |
| `GET` | `/api/history` | Snapshot summaries |
| `GET` | `/api/history/:id` | A projected historical snapshot and its topologies |
| `GET` | `/api/compare?from=:id&to=:id` | Semantic diff between any two snapshots |
| `GET` | `/api/mac-timelines` | Retained MAC index with labels, retrieval range, branch counts, and identity-review status |
| `GET` | `/api/mac-timelines/:mac` | Per-snapshot projected branches, addresses, identity fields, and direct responses for one MAC |
| `GET` | `/api/tcp-service-presets` | TCP service presets, including observed Kubernetes NodePorts |
| `POST` | `/api/tcp-service-scan` | Start independent range-wide TCP service discovery |
| `GET` | `/api/udp-service-presets` | Bounded UDP protocol-probe presets |
| `POST` | `/api/udp-service-scan` | Start independent range-wide UDP service discovery |
| `POST` | `/api/scan` | Start `local`, `passive`, `standard`, or `deep`; returns `202` and a job |
| `GET` | `/api/scans/:id` | Poll job progress/result |
| `DELETE` | `/api/scans/:id` | Cancel a job |
| `GET` | `/api/automation` | Schedules, notifications, and an active scheduled scan |
| `POST` | `/api/schedules` | Create a bounded TCP or UDP schedule |
| `PATCH` | `/api/schedules/:id` | Update or enable/disable a schedule |
| `DELETE` | `/api/schedules/:id` | Delete a schedule without deleting observations |
| `POST` | `/api/schedules/:id/run` | Run one saved schedule immediately |
| `POST` | `/api/notifications/read` | Mark new-port notifications as read |
| `GET` | `/api/database` | Database schema, content counts, import limit, and active scan |
| `GET` | `/api/database/export` | Download the complete portable Boushun database |
| `POST` | `/api/database/import/preview` | Validate and summarize a database without changing local state |
| `POST` | `/api/database/import` | Replace the database after `IMPORT` confirmation and a local backup |
| `POST` | `/api/database/reset` | Clear the database after `RESET` confirmation and a local backup |
| `PUT` | `/api/layout` | Save pinned node positions |
| `GET` | `/api/settings` | Interface policies |
| `PUT`, `PATCH` | `/api/settings/interfaces/:name` | Control map, identity, and scan participation |
| `PUT` | `/api/devices/:id/override` | Save name, role, and tags |
| `POST` | `/api/devices/:id/recommended-split` | Apply the current audited shared-MAC split recommendation |
| `POST` | `/api/overrides/merge` | Merge device projections |
| `POST` | `/api/overrides/split` | Split selected IPs to another device projection |
| `GET` | `/api/overrides` | Overrides and audit records |
| `GET` | `/api/export` | Download snapshot, inventory, views, and overrides |
| `GET` | `/api/export/inventory.csv` | Download the current device inventory as CSV |
| `GET` | `/api/export/ports.csv` | Download current confirmed and uncertain service observations as CSV |

## Observation and reset semantics

`local` reads only interface and route configuration. `passive` explicitly retrieves cache and configured source records without active probes. `standard` and `deep` perform the separately authorized checks described in [operations](operations.md#scan-profiles-and-safety). Startup performs no live collection. A new local demo database is seeded once; restarting an existing or reset database never reseeds it.

Projected devices and IP assignments expose `observation.kind` (`local`, `registered`, `response`, or `candidate`), `retrievedAt`, `sourceObservedAt`, `lastResponseAt`, and address/method-scoped `responses`. Unknown times are null. Device status is respectively `configured`, `registered`, `responded`, or `unconfirmed`. Cache states remain raw evidence, not device reachability. Candidate records remain in inventory exports and are excluded from default topology. Kubernetes conditions are API-reported metadata, not direct response evidence.

Current state retains check coverage and original response times in `snapshot.observationChecks`. Later successful checks supersede only the addresses and ports they cover for the same method. A failed/cancelled job cannot replace saved results. Presence includes `firstRetrievedAt`, `lastRetrievedAt`, `firstResponseAt`, `lastResponseAt`, and `responseCount`; legacy `firstSeenAt`/`lastSeenAt`/`observationCount` describe retrieval history, and `currentlyObserved` means a retained direct confirmation, not continuous online status. Inventory CSV includes retrieval/source/response times and responding addresses.

Reset clears observations, history, overrides, layout, interface policies, schedules, and notifications. It retains the disclosed local recovery backup and does not modify OS caches or external source files. Active scans block reset, and requests admitted against a replaced database are rejected with `409`. After reset, state and history stay empty until an explicit collection or import.

## MAC-centered history

MAC timeline endpoints use canonical MAC addresses as a read-only query and
presentation axis over retained raw snapshots. Each snapshot is projected
independently with the current overrides and interface settings. A timeline
begins at the first retained snapshot whose projected interface explicitly
carries the selected MAC, and each entry keeps that snapshot's retrieval
provenance.

`GET /api/mac-timelines` returns `retention` and an `items` array. Each item has a
canonical lowercase colon-separated `mac`, preferred label, manufacturer,
locally-administered flag, first/last retrieval times, observation-point count,
distinct projected branch count, and identity-review status.

`GET /api/mac-timelines/:mac` accepts canonical, hyphenated, or compact input and
returns the canonical MAC, retention metadata, a summary, and oldest-first
snapshot entries. Each entry contains one or more projected device branches with
identity metadata, addresses, retrieval/source/response times, scoped responses,
and qualified changes since the previous observation of that branch. Manual
splits and shared-MAC cases remain separate branches. Invalid input returns
`400`; a valid MAC absent from retained projected history returns `404`.

Responses contain projected identity fields, addresses, timestamps, and scoped
direct-response metadata. Connectivity remains unknown when a snapshot has no
entry for the MAC, an address leaves a later projection, or direct-response
evidence is absent.

## Example

```console
job_id=$(curl -fsS -H 'content-type: application/json' \
  -d '{"profile":"standard","cidr":"192.168.50.0/24"}' \
  http://127.0.0.1:4177/api/scan | jq -r .job.id)
curl -fsS "http://127.0.0.1:4177/api/scans/$job_id"
```
