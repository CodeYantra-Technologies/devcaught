Dedicated local authentication database
======================================

From the project root in your normal WSL terminal, run:

```sh
bash scripts/postgres-dev/setup.sh
```

This is a fresh-setup command, not a reset or repair command. It refuses existing
resource names, Compose project resources, or the credential directory. If any
step fails, preserve the new resources and diagnose the failure before proceeding;
do not delete volumes or rerun against an existing database.

Requires Docker Compose with `up --wait`, Node.js >=22.13, installed project
dependencies, and permission to create the external credential directory.
Compose receives `/dev/null` as its env file; no .env files are loaded.

Resources: project `devcaught-auth-dev`, service `postgres-dev`, container
`devcaught-pg-dev`, database `devcaught_auth_dev`, volume
`devcaught_pg_dev_data`, internal network `devcaught_pg_dev_net`. No ports are
published. The one-off setup container is removed after execution. Existing
containers, networks, SQLite data and volumes are not modified.

Independent random secrets are generated at
`~/.local/share/devcaught/auth-dev-secrets/` with directory mode 0700 and file
mode 0600. The bootstrap administrator, owner and app passwords are separate.
The app role has database CONNECT, schema USAGE, CRUD on the seven application
tables, and SELECT on the migration ledger; it has no schema creation, role
administration or superuser rights. No default grants extend to future tables.

The existing migrator applies 0001, 0002 and 0003 in filename order with its
existing per-file transaction and ledger. The verification calls the existing
privateInboxTargetReady checker as devcaught_auth_app inside a read-only
transaction, also asserting the expected migration ledger. Only status and
migration names are printed; failure details are deliberately suppressed.

The application is not connected by this task. A later approved connection must
mount only app_password and better_auth_secret into the application and attach
it to devcaught_pg_dev_net. A launcher must read these files inside the container,
construct a URL with percent-encoded credentials for
devcaught_auth_app at postgres-dev:5432/devcaught_auth_dev, set DATABASE_URL and
BETTER_AUTH_SECRET only in the application child environment, and never log
them. Do not put credential-bearing URLs into Compose, CLI arguments or source
files. The current runtime image needs a separately approved launcher/mount
configuration change. The private inbox release guard remains false.
