# Boushun HTTP API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health and active scan |
| `GET` | `/api/state` | Latest v2 inventory, all topologies, source health, presence, settings, semantic diff, layout, overrides |
| `GET` | `/api/history` | Snapshot summaries |
| `GET` | `/api/history/:id` | A projected historical snapshot and its topologies |
| `GET` | `/api/compare?from=:id&to=:id` | Semantic diff between any two snapshots |
| `GET` | `/api/tcp-service-presets` | TCP service presets, including observed Kubernetes NodePorts |
| `POST` | `/api/tcp-service-scan` | Start independent range-wide TCP service discovery |
| `GET` | `/api/udp-service-presets` | Bounded UDP protocol-probe presets |
| `POST` | `/api/udp-service-scan` | Start independent range-wide UDP service discovery |
| `POST` | `/api/scan` | Start `passive`, `standard`, or `deep`; returns `202` and a job |
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
| `PUT` | `/api/settings/interfaces/:name` | Control map, identity, and scan participation |
| `PUT` | `/api/devices/:id/override` | Save name, role, and tags |
| `POST` | `/api/devices/:id/recommended-split` | Apply the current audited shared-MAC split recommendation |
| `POST` | `/api/overrides/merge` | Merge device projections |
| `POST` | `/api/overrides/split` | Split selected IPs to another device projection |
| `GET` | `/api/overrides` | Overrides and audit records |
| `GET` | `/api/export` | Download snapshot, inventory, views, and overrides |
| `GET` | `/api/export/inventory.csv` | Download the current device inventory as CSV |
| `GET` | `/api/export/ports.csv` | Download current confirmed and uncertain service observations as CSV |

## Example

```console
job_id=$(curl -fsS -H 'content-type: application/json' \
  -d '{"profile":"standard","cidr":"192.168.50.0/24"}' \
  http://127.0.0.1:4177/api/scan | jq -r .job.id)
curl -fsS "http://127.0.0.1:4177/api/scans/$job_id"
```
