import { readFileSync, chownSync } from 'node:fs';
import { spawn } from 'node:child_process';

try {
  const read = name => {
    const value = readFileSync(`/run/secrets/${name}`, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('credential format');
    return value;
  };
  const url = new URL('postgresql://devcaught_auth_app@postgres-dev:5432/devcaught_auth_dev');
  url.password = read('app_password');
  const env = { ...process.env, DATABASE_URL: url.toString(), BETTER_AUTH_SECRET: read('better_auth_secret') };
  // This directory belongs exclusively to the new, empty candidate volume.
  chownSync('/app/data', 1000, 1000);
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: '/app', env, uid: 1000, gid: 1000, stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Candidate application launch failed'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch {
  console.error('Candidate credential loading or volume initialization failed');
  process.exitCode = 1;
}
