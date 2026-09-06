# Boushun Configuration and Data Sources

Run commands in this document from the repository root. Relative paths are resolved from that directory.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BOUSHUN_HOST` | `127.0.0.1` | Loopback HTTP listen address (`127.0.0.1`, `::1`, or `localhost`) |
| `BOUSHUN_PORT` | `4177` | HTTP listen port |
| `BOUSHUN_DATA_DIR` | repository `data/` or container `/data` | State directory |
| `BOUSHUN_ALLOWED_CIDRS` | unset; active scans disabled | Comma-separated IPv4 CIDRs; the entire requested scan range must be allowed |
| `BOUSHUN_DHCP_LEASE_PATHS` | known dnsmasq paths | Colon-separated dnsmasq, ISC, or Kea lease files |
| `KUBECONFIG` | standard kubeconfig search | Optional path used by the Kubernetes client |
| `BOUSHUN_OUI_PATH` | `$BOUSHUN_DATA_DIR/oui.csv` | IEEE MA-L CSV |
| `BOUSHUN_SNMP_CONFIG` | unset | SNMPv3 target JSON path |
| `BOUSHUN_CONTROLLER_SNAPSHOT_PATHS` | unset | Colon-separated normalized controller JSON exports |

## Container inputs

Mount SNMPv3 configuration, kubeconfig, controller exports, and DHCP leases explicitly. For example, create an ignored `compose.override.yaml` after creating the referenced local files:

```yaml
services:
  boushun:
    environment:
      BOUSHUN_SNMP_CONFIG: /run/boushun/snmp-targets.json
      KUBECONFIG: /run/boushun/kubeconfig
    volumes:
      - ./config/snmp-targets.json:/run/boushun/snmp-targets.json:ro
      - ./config/kubeconfig:/run/boushun/kubeconfig:ro
```

Remove unused entries. A kubeconfig that refers to separate certificate files also needs those files mounted and its paths adjusted for the container. Use the same pattern with `BOUSHUN_CONTROLLER_SNAPSHOT_PATHS` or `BOUSHUN_DHCP_LEASE_PATHS` for other read-only sources. Never bake credentials into the image or commit the local configuration files.

## OUI data

Boushun never downloads OUI data at runtime. Update the local database deliberately:

```console
./scripts/update-oui.sh data/oui.csv
```

For the standard container, update the persistent volume instead:

```console
docker compose exec boushun ./scripts/update-oui.sh /data/oui.csv
```

The script downloads the IEEE MA-L UTF-8 CSV and writes it mode `0600`.

## SNMPv3

Copy `config/snmp-targets.example.json` outside the source tree, replace the placeholder keys, set mode `0600`, and point `BOUSHUN_SNMP_CONFIG` to it. The supported levels are `noAuthNoPriv`, `authNoPriv`, and `authPriv`; `authPriv` with SHA-256 and AES is the default. Credentials are read from the file and excluded from API responses, evidence, errors, and command lines.

Only explicitly listed targets are contacted. Each session is closed after its bounded read. LLDP produces strong links; an FDB-only placement is inferred.

## Controller bridge schema

Vendor bridge scripts can periodically produce read-only JSON for Boushun while keeping controller credentials in the bridge environment:

```json
{
  "devices": [{ "id": "device:ap-1", "name": "AP", "mac": "00:11:22:33:44:55", "addresses": ["192.168.50.20"], "role": "access-point" }],
  "links": [{ "source": "device:switch-1", "target": "device:ap-1", "layer": "l2", "relation": "controller-uplink", "confidence": "strong", "label": "port 8" }],
  "services": []
}
```
