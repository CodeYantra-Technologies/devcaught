# Contributing to DevCaught

Thanks for helping improve DevCaught. It is a local-development preview, so please keep changes and reports scoped to local development use.

## Local development

- Node.js 22.13.0 or later
- npm

Install dependencies and start the development app with the instructions in the [README quick start](README.md#quick-start). Keep test data synthetic and follow the README's local-only capture and database guidance.

## Focused checks

Run the relevant focused checks for your change:

```bash
npm run test:devcaught
npm run test:local-capture
```

For changes that affect types, also run:

```bash
npm run typecheck
```

## Report a bug

Open a GitHub issue with a concise title and enough detail to reproduce the problem. A useful report includes:

- The expected and observed behavior
- Steps to reproduce, with synthetic example data
- Operating system and Node.js version
- The command used and relevant error output
- Whether the issue affects local SMTP, synthetic SMS, JSON webhook capture, or the dashboard

Do not include credentials, tokens, private messages, personal data, production payloads, or sensitive logs. Redact secrets and identifying information from any output before posting.

## Propose a change

Open an issue to describe substantial changes before starting implementation. For a pull request, explain the problem and proposed solution, summarize the change, and include the focused checks you ran. Keep pull requests limited to one coherent improvement and update relevant documentation when behavior or setup guidance changes.

## Security vulnerabilities

Do not report security vulnerabilities in a public issue. If GitHub's private vulnerability reporting is enabled for this repository, use the repository's **Security** tab to submit a private report. If it is not enabled, do not post exploit details publicly; use a maintainer contact channel already published by the organization, if one is available.
