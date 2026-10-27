import {parseArguments,performRelease} from './claim-release.mjs';
try {
  const options=parseArguments(process.argv.slice(2));
  console.log(JSON.stringify(performRelease(options),null,2));
}catch {
  // Never print raw subprocess output, evidence records, or exception values.
  console.error('BLOCKED: claim unchanged unless a durable prepared release record exists; check arguments, metadata, coordination, processes and Docker availability.');
  process.exitCode=1;
}
