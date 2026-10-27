import {writeSync} from 'node:fs';
import {startIngestion} from './ingestion-bootstrap.mjs';

// Suppress application console output. Only our explicit, allowlisted writes
// reach stdout; stderr is ignored by the outer runner as an additional boundary.
for(const key of ['log','info','warn','error','debug'])console[key]=()=>{};
// No secret is required: pg.Pool is lazy and no recipient or query is submitted.
// Network isolation prevents this placeholder ever reaching the shared database.
process.env.DATABASE_URL='postgresql://devcaught_auth_app@127.0.0.1:9/devcaught_auth_dev';
let lastPhase='module_import';
const report=row=>{
  lastPhase=row.startupPhase??lastPhase;
  writeSync(1,JSON.stringify({startupPhase:row.startupPhase,outcome:row.outcome,
    exceptionName:row.exceptionName,errorCode:row.errorCode})+'\n');
};
const timer=setTimeout(()=>{
  writeSync(1,JSON.stringify({startupPhase:lastPhase,outcome:'fail',exceptionName:null,errorCode:'ETIMEDOUT'})+'\n');
  process.exit(1);
},30000);
try {
  const {runtime,server}=await startIngestion({report});
  // ready means both listeners were bound, without a message or routing lookup.
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await runtime.smtp.close();runtime.store.close();clearTimeout(timer);process.exit(0);
} catch {clearTimeout(timer);process.exit(1);}
