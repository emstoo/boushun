# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Default branch | Yes |

Security fixes are made against the supported release line and the default branch. Upgrade to a supported version before reporting a problem that exists only in an older release.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository when it is available: open the repository's **Security** tab, select **Advisories**, then **Report a vulnerability**.

Do not include credentials, Boushun database exports, network inventories, packet captures, or exploit details in a public issue. If private vulnerability reporting is unavailable, open a public issue containing only a request for a private contact channel.

Include the affected version or commit, deployment method, impact, reproduction conditions, and a minimal redacted proof of concept. Reports are handled on a best-effort basis; no response or remediation deadline is guaranteed.

## Security model

Boushun is a local network observation tool for one operator on the probe host. It accepts only loopback listen addresses.

- The HTTP server has no built-in authentication, TLS termination, session management, RBAC, or trusted-proxy handling. Anyone able to reach the listener can read inventory and invoke mutations.
- Boushun validates the request `Host` and rejects cross-origin browser requests. These checks reduce DNS-rebinding and CSRF exposure but do not authenticate local users or processes.
- Remote and multi-user publication, including operation behind an external proxy, is not supported or validated.
- The Docker deployment uses host networking to observe the Linux host network stack and grants `NET_RAW` for ICMP probes. Review the Compose file before deployment.
- Only scan networks you own or are explicitly authorized to inspect. Keep `BOUSHUN_ALLOWED_CIDRS` narrowly scoped. Unset or empty allowlists disable active scans, and malformed CIDRs are rejected.
- Database exports and the persistent data directory can contain IP addresses, MAC addresses, hostnames, discovered services, topology evidence, and operator annotations. Treat them as sensitive operational data.
- SNMPv3 credentials, kubeconfig files, DHCP leases, and controller exports must remain outside the repository and be mounted read-only when required.

Reports about a bypass of scan boundaries, credential disclosure, unauthorized file access, injection, cross-site scripting, or unintended remote exposure are especially useful.

## CI and merge protection

The default branch requires the Node.js, browser, and container acceptance checks. CodeQL default setup analyzes JavaScript/TypeScript and GitHub Actions. A separate active code-scanning ruleset requires CodeQL results and blocks pull requests that introduce security alerts rated high or critical, or code-scanning alerts with error severity. Missing, pending, or failed required analysis also blocks merging, as described in [GitHub's merge-protection documentation](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/set-merge-protection).

The intended CodeQL rule is recorded in [.github/code-scanning-ruleset.json](.github/code-scanning-ruleset.json). GitHub enforces it through repository settings, not by reading that file automatically. Keep the live rule aligned with the file without weakening the existing CI checks, squash-only pull request flow, or no-bypass policy. Container acceptance uses only a disconnected synthetic network and does not collect the runner's LAN inventory.
