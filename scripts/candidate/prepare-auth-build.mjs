import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const expectedRelease = `// Task 2C verified disposable PostgreSQL only. Keep false until the application's
// actual target database is verified. Activation remains a separate reviewed change;
// privateInboxTargetReady also enforces target readiness on every activated request.
// No request header, environment variable, or browser flag can enable access.
export const PRIVATE_INBOX_POSTGRES_VERIFIED = false;
`;
export function transform(release, server) {
  if (release !== expectedRelease) throw new Error('Normal release guard does not match exactly');
  const replacements = [
    ['import { PRIVATE_INBOX_POSTGRES_VERIFIED } from "./private-inbox-release.ts";',
      'import { candidateAuthorizationEnabled } from "./candidate-auth-policy.ts";'],
    ['if (!PRIVATE_INBOX_POSTGRES_VERIFIED) return inboxUnavailable();',
      'if (!candidateAuthorizationEnabled(request)) return inboxUnavailable();'],
    ['postgresVerified: PRIVATE_INBOX_POSTGRES_VERIFIED,', 'postgresVerified: true,'],
  ];
  let result = server;
  for (const [from, to] of replacements) {
    if (result.split(from).length !== 2) throw new Error('Expected server guard does not match exactly');
    result = result.replace(from, to);
  }
  return result;
}
// Explicit invocation only; importing the transform for tests performs no writes.
if (process.argv[2] === '--inside-candidate-build') {
  const release = readFileSync('src/lib/inbox/private-inbox-release.ts', 'utf8');
  const path = 'src/lib/inbox/private-inbox-api.server.ts';
  writeFileSync(path, transform(release, readFileSync(path, 'utf8')));
  copyFileSync('scripts/candidate/auth-policy.ts', 'src/lib/inbox/candidate-auth-policy.ts');
}
