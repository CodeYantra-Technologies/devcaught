<p align="center">
  <img src="public/devcaught-logo.svg" alt="DevCaught - Everything your app sends. Caught." width="620">
</p>

# DevCaught

**Everything your app sends. Caught.**

DevCaught is a local-first developer inbox that captures application messages during development and surfaces the information developers actually care about.

Point your app at a local SMTP server. DevCaught stores the mail, detects OTPs and links, and puts the useful bits on a dashboard — without sending anything to the internet.

**CodeYantra Technologies · V0.1**

---

## Quick start

DevCaught requires **Node.js 22.13.0 or later**.

```bash
git clone https://github.com/CodeYantra-Technologies/devcaught.git
cd devcaught
npm install
npm run dev
```

This starts:

| Service | Default |
| --- | --- |
| Dashboard | `http://127.0.0.1:8080` |
| SMTP receiver | `127.0.0.1:1025` |
| HTTP API | `127.0.0.1:8025` |

Configure your local app to send development email to DevCaught:

```text
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
```

Then trigger a signup OTP, welcome email, password reset, or magic link from your app. The email appears in the DevCaught dashboard instead of going to a real inbox.

You can also send a sample message from this repo:

```bash
npm run send:test-mail
npm run send:test-mail -- --fixture=link
```

---

## What DevCaught is

DevCaught is a local testing tool for developers building apps that send email.

Use it when you want to test:

- Signup OTP emails
- Welcome emails
- Password reset links
- Magic login links
- Test receipts or notification emails

Instead of sending real email through Gmail, SendGrid, Resend, Mailgun, or another provider during development, point your app at DevCaught's local SMTP server and inspect the result instantly.

```text
Your local app -> DevCaught SMTP -> SQLite -> Dashboard
```

## What DevCaught is not

DevCaught is intentionally small in V0.1.

- It is not a Gmail inbox.
- It does not read incoming Gmail messages.
- It does not deliver email to real users.
- It does not run in Vercel/Supabase hosted environments via `127.0.0.1`.
- It is not a cloud email service.
- It has no AI, auth, Docker, SMS, push notifications, or webhooks yet.

`127.0.0.1:1025` means "this same machine". If your app is deployed on Vercel or Supabase, `127.0.0.1` points to their server, not your laptop. DevCaught is for local development.

## Features

- Local SMTP capture (`127.0.0.1:1025` by default)
- SQLite storage on disk
- Web dashboard with search, detail, delete, and clear
- Deterministic OTP detection (no AI)
- HTTP(S) link detection
- Copy buttons for OTPs and links
- Sandboxed HTML preview (scripts cannot run; remote images blocked)
- Test email composer (ingest pipeline — not an SMTP health check)
- Settings page that reports **real** SMTP and HTTP listener state

## Requirements

- **Node.js 22.13.0 or later** (Node 22 LTS)

Verified on Node.js 22.23.2: the built-in `node:sqlite` driver works **without** `--experimental-sqlite` and **without** a native addon. That is why DevCaught does not depend on `better-sqlite3`.

`npm install` does not compile C++. The same install works on Windows, macOS, and Linux from the official Node binaries.

Node may print:

```text
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

That warning is expected and harmless. The store is isolated behind `InboxStore` if the API ever needs to be swapped.

## Local services

| Service | Default | Env |
| --- | --- | --- |
| SMTP server | `127.0.0.1:1025` | `DEVCAUGHT_HOST`, `DEVCAUGHT_SMTP_PORT` |
| HTTP API | `127.0.0.1:8025` | `DEVCAUGHT_HOST`, `DEVCAUGHT_HTTP_PORT` |
| Dashboard | Vite dev server (live reload) | — |

Open the dashboard in your browser, then confirm Settings:

```text
SMTP Server: Running
Host: 127.0.0.1
Port: 1025

HTTP Dashboard: Running
Port: 8025
```

If a port is already taken, DevCaught prints a message like:

```text
DevCaught could not start the SMTP server on 127.0.0.1:1025 because that port is already in use.
Set DEVCAUGHT_SMTP_PORT to a free port, for example:
  DEVCAUGHT_SMTP_PORT=1026 npm run dev
```

## SMTP configuration

In your application:

```text
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
```

No username, password, or TLS. Bind is loopback-only by default so this is not an internet mail server.

### Example: Node.js / Nodemailer

```js
import nodemailer from "nodemailer";

const transport = nodemailer.createTransport({
  host: "127.0.0.1",
  port: 1025,
  secure: false,
  tls: { rejectUnauthorized: false },
});

await transport.sendMail({
  from: "NexaField <noreply@example.test>",
  to: "developer@example.test",
  subject: "Verify your account",
  text: "Your verification code is 482913.\nThis code expires in 10 minutes.",
});
```

From this repo, with DevCaught already running:

```bash
npm run send:test-mail
npm run send:test-mail -- --fixture=link
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVCAUGHT_HOST` | `127.0.0.1` | Bind address for SMTP and HTTP |
| `DEVCAUGHT_SMTP_PORT` | `1025` | SMTP listen port |
| `DEVCAUGHT_HTTP_PORT` | `8025` | HTTP API listen port |
| `DEVCAUGHT_DB_PATH` | `data/devcaught.db` | SQLite file (`:memory:` allowed) |
| `DEVCAUGHT_SMTP_SIZE_LIMIT` | `10485760` (10 MB) | Reject oversized SMTP DATA |

## How a message is caught

```text
SMTP Receiver  →  Normalizer  →  Parsers  →  SQLite  →  REST API  →  Dashboard
Test composer  ↗
```

SMTP and the test composer both call `InboxService.ingest()`. The test composer proves parsing and storage. It does **not** prove that port 1025 is reachable — that is the SMTP status on Settings.

The list endpoint never returns raw MIME. Raw MIME is loaded only from `GET /api/messages/:id/raw`.

## Project layout

```text
apps/server/           SMTP receiver, ingest, SQLite, Express API
packages/parsers/      otpParser, linkParser (pure, tested)
packages/shared/       types and defaults
src/                   React dashboard
data/                  SQLite file (gitignored)
```

The dashboard lives in `src/` so `npm run dev` is a single Vite process that also boots SMTP + HTTP. Parser and storage code stay out of the UI.

## Scripts

```bash
npm run dev              # dashboard + SMTP + HTTP API
npm run test:devcaught   # parsers, store, SMTP capture
npm run typecheck
npm run send:test-mail
```

## Brand assets

<p>
  <img src="public/devcaught-logo-concept.png" alt="DevCaught generated logo concept" width="420">
</p>

- Primary SVG logo: `public/devcaught-logo.svg`
- App mark: `public/devcaught-mark.svg`
- Generated concept: `public/devcaught-logo-concept.png`

## Project status

V0.1 is a local developer tool. It is useful the first time an app sends mail. It is not a product inbox, not a cloud service, and not an email client.

## Roadmap

**V0.1**
- Email capture
- OTP detection
- Link detection

**V0.2**
- Webhook inbox
- Payment / order / transaction detection

**V0.3**
- SMS simulation
- Push notification simulation

**Future**
- Test personas
- Plugin / parser system
- Optional self-hosted deployment

## License

MIT © CodeYantra Technologies
