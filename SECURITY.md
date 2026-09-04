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
- Only scan networks you own or are explicitly authorized to inspect. Keep `BOUSHUN_ALLOWED_CIDRS` narrowly scoped.
- Database exports and the persistent data directory can contain IP addresses, MAC addresses, hostnames, discovered services, topology evidence, and operator annotations. Treat them as sensitive operational data.
- SNMPv3 credentials, kubeconfig files, DHCP leases, and controller exports must remain outside the repository and be mounted read-only when required.

Reports about a bypass of scan boundaries, credential disclosure, unauthorized file access, injection, cross-site scripting, or unintended remote exposure are especially useful.
