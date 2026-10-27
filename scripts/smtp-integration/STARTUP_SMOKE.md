Minimal ingestion startup smoke test (execution not authorized yet)
=================================================================

After separate approval, run once in WSL:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run-smoke.mjs
```

New resources are image devcaught:ingestion-startup-smoke and container
devcaught-ingestion-startup-smoke. Existing names cause refusal. No Compose
project, named volume, custom network, published port, web process, proxy or
verifier container is needed. SQLite lives only in a new 32 MiB tmpfs at /app/data;
the container is read-only, runs as UID/GID 1000, drops capabilities and uses
Docker network mode none. Existing resources and evidence remain untouched.

The image independently bundles the existing standalone server and reuses the
harness bootstrap. It does not depend on or retag previous application images.
It does not load secret mounts, .env files, auth bootstrap or customer data.

PostgreSQL connectivity is NOT required for this smoke test. Private SMTP startup
constructs a lazy pool; no query is submitted until envelope recipient resolution.
A password-free loopback placeholder satisfies connection configuration validation
without using real credentials. No SMTP connection or message is sent, so no
registry lookup or provisioning occurs. Network mode none also prevents reaching
the shared PostgreSQL container. This checks startup, not routing readiness.

Ready is reported only after the reused bootstrap successfully imports the bundle,
initializes the runtime, verifies SMTP's running status and awaits the HTTP listener.
It then closes listeners/store and exits. An internal 30-second timer and external
45-second execution timeout bound startup. The runner stops only the new container
after collecting allowlisted phases, exception name/code and process exit status.
No raw stdout noise, arbitrary stderr, messages, stacks or environment values enter
evidence. Logs from application console methods are suppressed in this smoke process.
The stopped container and image are retained, and sanitized JSONL is preserved in
a new /tmp/devcaught-ingestion-smoke-* directory. SQLite tmpfs is ephemeral.

Static compilation cannot establish container startup success. Failure before the
smoke entry/helper modules load may yield only exit status; failures inside module
import/runtime/listener startup carry the bootstrap's sanitized phase/name/code.
The existing receiver/listener may have discarded an underlying code; it cannot
be reconstructed. A successful smoke test does not validate PostgreSQL access,
SMTP delivery, ownership isolation, revocation or retries. It is not a full SMTP
integration retry and does not consume or remove the prior retry claim file.
