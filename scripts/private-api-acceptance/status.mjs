// Read-only entry point: no runner import, subprocesses, recovery, or writes.
import {inspectStatus} from './evidence.mjs';
if(process.argv.length!==2)throw new Error('Usage: node scripts/private-api-acceptance/status.mjs');
console.log(JSON.stringify(inspectStatus(),null,2));
