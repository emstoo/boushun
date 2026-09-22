# Boushun Helm chart

This chart runs one Boushun probe on a Linux Kubernetes node. It deliberately uses the node network and binds only to `127.0.0.1`; it does not create a Service or Ingress. Access the UI from the scheduled node or through an authenticated tunnel that terminates at that node's loopback address.

## Prerequisites and impact

- The target namespace must permit `hostNetwork` and `hostPort`. Kubernetes Pod Security Baseline and Restricted policies forbid those settings, so use a deliberately exempted namespace rather than weakening policy cluster-wide.
- Port `4177` (or the configured `port`) must be free on the selected node.
- The chart runs exactly one replica with a `Recreate` strategy. The JSON store supports one process, the default claim is `ReadWriteOnce`, and the loopback host port cannot be shared. Updates therefore have a short interruption and are not highly available.
- A default StorageClass, an existing claim, or `persistence.enabled=false` is required. Disabling persistence loses state whenever the Pod is replaced.
- The chart-created claim is retained on uninstall by default. It then becomes orphaned; set `persistence.existingClaim` to its name before reinstalling, or delete it deliberately only after exporting and verifying the database.
- Chart-managed RBAC grants only `list` for core Nodes and Services. Set `rbac.create=false` and provide `serviceAccount.name` to use a pre-provisioned ServiceAccount instead.

Before an upgrade, export the Boushun database from the UI and confirm the existing Pod is healthy. Stop if the replacement cannot start, cannot read the Kubernetes inventory, or shows a state discrepancy. The `Recreate` strategy leaves the previous ReplicaSet available for a Helm rollback, but database-format compatibility must still be checked for the versions involved.

## Install

Create a local values file containing only the private or link-local ranges that this probe is allowed to scan:

```yaml
allowedCIDRs:
  - 192.168.50.0/24

nodeSelector:
  kubernetes.io/hostname: worker-1
```

Store that file outside the public repository. Then install or upgrade the release from the repository root:

```console
helm upgrade --install boushun ./charts/boushun \
  --namespace boushun \
  --create-namespace \
  --values /path/to/boushun-values.yaml
```

An empty `allowedCIDRs` list is valid and disables active scans. The chart defaults to the image tag in `Chart.yaml`. Set `image.tag` to a specific release, or set `image.digest` to a `sha256:` digest for an immutable `repository@digest` reference; a nonempty digest takes precedence over the tag.

## Existing input Secrets and files

Do not put credentials in Helm values. Create Secrets from the documented trusted source outside this chart, then mount only the existing Secret reference. For example:

```yaml
extraEnv:
  - name: BOUSHUN_SNMP_CONFIG
    value: /run/boushun-inputs/snmp-targets.json
extraVolumeMounts:
  - name: inputs
    mountPath: /run/boushun-inputs
    readOnly: true
extraVolumes:
  - name: inputs
    secret:
      secretName: boushun-inputs
```

The chart never creates or copies credentials. Kubernetes in-cluster authentication uses the selected ServiceAccount automatically. `extraEnv` cannot redefine `BOUSHUN_HOST`, `BOUSHUN_PORT`, `BOUSHUN_DATA_DIR`, or `BOUSHUN_ALLOWED_CIDRS`; configure those through the chart's dedicated values.

## Validate locally

```console
helm lint charts/boushun --strict
helm template boushun charts/boushun --namespace boushun --values /path/to/boushun-values.yaml
```
