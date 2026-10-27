# Closed-guard HTTPS browser candidate — Task 2K.2

Configuration only. No build, startup, certificate generation/trust installation,
database operation or fixture provisioning is authorized by these files.
Use only `compose.https-candidate-2k2.yaml`; never merge it with existing candidate
files or invoke setup.sh/run-auth.sh. Those scripts build, provision or replace
resources. Existing candidate authorization is HTTP-only and is not reused here.

## Declared isolation and configuration

- Canonical origin: `https://app.devcaught.test:8443`.
- Required exact trusted-origin set: only that origin. The `x-review-contract`
  section records this requirement; it does NOT configure application behavior.
  `BETTER_AUTH_URL` is the existing canonical URL input. Its mapping to the actual
  auth trusted-origin set and the framework's interpretation of forwarded HTTPS
  are NOT VERIFIED. No invented trusted-origin variable or broad proxy trust is
  configured. Stop if the existing application cannot honor this contract without
  security-code changes; obtain a separate review rather than weakening checks.
- The closed normal candidate image must keep the shipped release guard false.
  No test capability, authorization transform, guard override or runtime unlock
  is configured. Private API requests must remain 503. Reuse the successful
  isolated API acceptance evidence; this candidate does not repeat it.
- Only `127.0.0.1:8443/TCP` maps to proxy port 443. No IPv6/wildcard/HTTP mapping,
  UDP/HTTP3, application, PostgreSQL, SMTP, ingestion or admin port is published.
  Caddy administration and automatic HTTP redirects are disabled.
- Proxy and app share the new internal frontend network. Only the app attaches
  to the existing `devcaught_pg_dev_net`; the proxy receives no database secrets.
  The application may have internal ingestion listeners inherited from its image;
  they are not exposed through the proxy. Docker networks are not per-port ACLs.
- All owned names include `https_browser_2k2` or `https-browser-2k2`; the PG network
  is the sole intentional existing resource. Compose itself may reuse named
  resources: a separately reviewed preflight MUST refuse existing project labels,
  containers, volumes and frontend network before startup. Do not delete conflicts.
- There is no build section or pull action. Caddy is fixed to `2.11.7-alpine`,
  reviewed against upstream release v2.11.7; registry availability, platform and
  immutable image digest are not verified. `pull_policy: never` requires prior,
  separately approved image availability. Record the resolved digest before use.
- `DEVCAUGHT_HTTPS_CANDIDATE_IMAGE` must be an independently reviewed immutable
  normal candidate image (`sha256:...` or repository@sha256:...), including the
  existing `/candidate-launch.mjs`, Node and normal `.output` on port 3000.
  It must NOT be the isolated acceptance or authorization-capability image.
  Compose interpolation does not enforce this identity; execution is blocked
  until the selected image's provenance, UI build and closed guard are confirmed.
- Fresh SQLite path: `/app/data/https-browser-synthetic-2k2.db`, in the uniquely
  named synthetic volume. Existing launcher initializes ownership and launches
  the application at UID/GID 1000. Its supervisor remains root with only the
  capabilities needed for ownership, credential reads and privilege dropping.
  This is not an all-processes-non-root deployment. No host customer storage mounts.
- Secret FILE PATHS only come from `DEVCAUGHT_AUTH_SECRET_DIR`. Existing launcher
  reads them inside the container. Compose runtime secrets are read-only mounts;
  no secret values, connection strings or .env files belong in commands/config.
  Secret ownership/mode/readability and development-only provenance remain a
  separate metadata-only preflight; do not print or inspect values.
- Filesystems are read-only except dedicated volumes and the app /tmp tmpfs.
  Caddy CA storage is private development material: do not share/export its keys.
  Docker log retention is disabled and Caddy logging is discarded. Do not attach
  to raw application output. Later evidence must record sanitized assertion/status
  categories only; no HAR, request bodies, cookies or invitation URLs. This avoids
  raw retention but does not establish production logging/alerting readiness.

## Browser-host mappings and trust — future prerequisites only

On the machine running the browser, the desired mappings are:

```
127.0.0.1 app.devcaught.test other.devcaught.test outside.devcaught-other.test
```

For a Windows browser, configure the Windows hosts file after separate approval;
WSL /etc/hosts alone does not configure Windows resolution. A WSL-native browser
needs its own local resolution. Confirm Windows-to-WSL localhost forwarding for
8443; do not solve failures with 0.0.0.0 binding, portproxy, tunnels or public DNS.
Use only these `.test` names; configure no public records or ACME issuer.

Caddy will generate the internal CA/certificates only on a separately authorized
startup. No certificates exist because of this configuration change. Confirm SANs,
validity and the expected root fingerprint; transfer only the public root cert to
the browser host. Trust it explicitly in a dedicated browser profile where
supported. Any broader trust-store installation/removal requires separate review.
Never transfer CA private keys, disable TLS verification, ignore certificate
errors or use a browser flag bypass. Windows and WSL trust stores are distinct.

Sibling origin `other.devcaught.test` is for same-site/cross-origin checks;
`outside.devcaught-other.test` is for cross-site checks. They return fixed text
and never proxy to the app. No CORS permission is added. The browser checklist
and synthetic identity lifecycle need separate approval before browser execution.

## Safe static checks

From the project root, with an already installed PyYAML (no installation needed):

```sh
python3 - <<'PY'
from pathlib import Path
import yaml
p = yaml.safe_load(Path('compose.https-candidate-2k2.yaml').read_text())
assert p['name'] == 'devcaught-https-browser-2k2'
assert set(p['services']) == {'proxy', 'candidate'}
ports = [(name, port) for name, service in p['services'].items()
         for port in service.get('ports', [])]
assert ports == [('proxy', {'target': 443, 'published': '8443',
                          'host_ip': '127.0.0.1', 'protocol': 'tcp'})]
assert all('build' not in service for service in p['services'].values())
assert p['services']['proxy']['image'] == 'caddy:2.11.7-alpine'
assert p['networks']['frontend']['internal'] is True
assert p['networks']['pg_dev']['external'] is True
assert p['services']['proxy']['networks'] == ['frontend']
assert p['services']['candidate']['networks'] == ['frontend', 'pg_dev']
assert p['x-review-contract']['exact_trusted_origins'] == [
    'https://app.devcaught.test:8443']
assert p['services']['candidate']['environment']['BETTER_AUTH_URL'] == \
    p['x-review-contract']['canonical_origin']
assert p['x-review-contract']['private_inbox_postgres_verified'] is False
print('PASS: offline YAML and declared isolation checks')
PY
```

This reads configuration only and does not expand variables, read secrets, create
resources or contact Docker. YAML parsing is not Compose schema validation.
If the reviewed Caddy version is already installed locally, an additional OFFLINE
adapter check can be proposed separately:

```
caddy adapt --config scripts/https-candidate/Caddyfile --adapter caddyfile >/dev/null
```

Do not substitute `caddy run`, `caddy start`, `caddy trust`, or `caddy validate`;
provisioning/validation can initialize storage or certificates. Do not invoke
Docker/Compose merely to validate these files during this task. Never source .env.

Upstream references used for configuration review:
- https://github.com/caddyserver/caddy/releases/tag/v2.11.7
- https://caddyserver.com/docs/caddyfile/options
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://caddyserver.com/docs/caddyfile/matchers

## Decision

Task 2K.2 static review completed after resuming the existing three files. YAML
parsing with duplicate-key rejection and declared port/network/volume/secret
checks passed. Static review confirmed canonical Host/protocol replacement,
removal of incoming forwarding claims, unchanged Origin/Sec-Fetch headers,
internal TLS issuance, disabled administration/HTTP redirects, and balanced
Caddyfile blocks. The existing launcher drops its application child to UID/GID
1000, and the inspected production release constant remains false.

Caddy is not installed in the review environment, so Caddy adapter parsing was
not performed. Compose schema rendering and image/runtime behavior were not
verified. These static findings do not establish the application's exact trusted
origins, live resource freshness, certificate trust, or browser acceptance.
No Docker, certificate, database, or browser operation was executed.

Configuration preparation is complete; startup/browser verification is NO-GO
until immutable image identity, exact application trusted-origin/proxy behavior,
resource freshness, secret/storage permissions, local networking and reviewed
Caddy adapter/schema validation are established. If HTTPS requires authorization
code changes, stop and report the blocker; no such changes are included here.
The smallest next step is offline adapter/schema review using already installed
reviewed tooling, plus confirmation of the existing application's configuration
contract without opening protected auth source. No startup or fixtures yet.
