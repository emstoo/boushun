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

## Static demo build and publication

The public demo is a static site containing synthetic observations, not a public Boushun server. It does not use the probe's persistent database or credential sources. Its [capabilities and limits](features.md#static-read-only-demo) differ from the local installation.

### Generate the artifact

From the repository root, with a Node.js version supported by [package.json](../package.json):

```console
npm ci
npm run demo:build
```

The build replaces `dist/demo/`; do not store hand-maintained files there. It creates a temporary store, starts a loopback-only server with the bundled synthetic collector and scheduler disabled, and captures projected state/history/database/automation responses plus the normal JSON/inventory-CSV/ports-CSV exports. It then closes the server and removes the temporary store. The observation time is the build time; tests inject a fixed clock. No live LAN collection is needed.

The [builder](../scripts/build-static-demo.js) copies the shared HTML, styles, and application modules unchanged and selects [static-demo-runtime.js](../src/web/static-demo-runtime.js) as the generated `runtime.js`. The normal server uses [runtime.js](../src/web/runtime.js). [api-client.js](../src/web/api-client.js) owns both runtime implementations and the shared export targets, while [capabilities.js](../src/web/capabilities.js) preserves control restrictions during rendering. The build does not rewrite application source or replace browser APIs. Relative asset paths support both root hosting and the `/boushun/` project subpath. The generated site needs only static hosting, not the temporary build server.

### Publish through GitHub Pages

The repository uses GitHub Actions as the Pages source, enforces HTTPS, and restricts the `github-pages` environment to the `main` branch. These are repository settings, not settings applied by the workflow. Before initial publication or when recreating the repository, verify **Settings → Pages → Build and deployment → Source → GitHub Actions**, **Enforce HTTPS**, and **Settings → Environments → github-pages → Deployment branches and tags** with only `main` allowed. Follow GitHub's [publishing-source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) and [environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) documentation. Pages must already be enabled; the workflow does not grant itself repository-administration access.

The [Pages workflow](../.github/workflows/pages.yml) runs after pushes to `main`. Once the workflow exists on `main`, a maintainer can also use **Actions → Pages → Run workflow**, selecting `main`, to rebuild and publish the current reviewed source. See GitHub's [manual workflow procedure](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow). Do not use a feature branch or weaken the environment restriction to publish an unreviewed artifact.

The jobs run in order: build `dist/demo/`, deploy that artifact to <https://emstoo.github.io/boushun/>, then check the public site. Build and smoke jobs have read-only repository access; only the deploy job receives `pages: write` and `id-token: write`. Publishing never changes the local probe, its database, or its loopback/Host/Origin boundary. See the [security policy](../SECURITY.md#static-demo-publication).

### Published demo check and recovery

After installing dependencies in the repository root, the public-site check can also be run locally:

```console
npx playwright install chromium
npm run test:smoke
```

This contacts only the fixed public demo URL and its static resources; it does not start a local server, deploy anything, or scan a LAN. It checks the document, synthetic fixture, visible topology, disabled scan controls, and a JSON download matching the loaded snapshot. The [test design](test-design.md#82-post-deployment-smoke) defines its deadlines, failure diagnostics, and coverage limits. A successful deploy job alone is not a successful publication check.

If the demo shows a fixture-loading error, the request and response body have a combined 15-second deadline. HTTP errors, invalid fixtures, and timeouts leave mutation controls disabled and show a persistent **Reload demo** action. Reload starts a fresh request and discards session-local map positions. There are no automatic retries or fallback requests to a live API.

If publication fails:

1. Identify whether build, deploy, or smoke failed in the Pages run. Record the source commit, deployment result, failing step, and user-visible condition. A smoke failure does not roll back the completed deployment; the failing site may already be public. A first deployment has no known-good published fallback.
2. Inspect the job logs and, when available, the `pages-smoke-failure-diagnostics` artifact containing the Playwright trace and failure screenshot. Separate setup/network failures from a fixture, asset, rendering, or export mismatch. Do not repeatedly rerun an unexplained failure until it happens to pass.
3. If the cause is understood and resolved without a source change, rerun only the failed smoke job using GitHub's [job rerun procedure](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs). It checks the currently served public URL, not a deployment pinned to the original run. Confirm which deployment is now live; rerunning an old build/deploy job can republish old source.
4. For an artifact defect, submit a fix or a revert to a known-good implementation through a pull request, pass the required checks, and squash-merge it to `main`. This produces a fresh synthetic artifact through the same workflow. Do not expose the local server, copy a real database into the artifact, or bypass branch/environment protection as a recovery shortcut.
5. Confirm that the resulting deployment and public smoke both pass, then verify the affected user path. Stop further publication if a timeout, mismatch, or partial failure remains unexplained. The smoke checks basic functionality from one browser location, not every CDN edge or proof that the latest commit is served everywhere.
