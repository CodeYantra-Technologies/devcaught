import {appendFileSync,writeSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {diagnostic,category} from './diagnostics.mjs';

/** Injectable only for synthetic bootstrap tests. No application source changes. */
export async function startIngestion({
  importModule=()=>import('./ingestion-build/ingestion.mjs'),
  report=row=>{
    const line=JSON.stringify(row)+'\n';
    try {appendFileSync('/app/data/process-diagnostics.jsonl',line,{mode:0o600,flush:true});}
    catch {writeSync(1,line);}
  },
}={}) {
  let startupPhase='module_import';
  const emit=(outcome,error)=>report(diagnostic({component:'application',processName:'ingestion',
    executionStage:'ingestion startup',startupPhase,outcome,category:error?category(error):'none',
    exitCode:error?1:null,shutdownReason:error?'startup_failure':null,
    exceptionName:error?.name,errorCode:error?.code}));
  try {
    emit('start');
    // argv[1] remains this bootstrap, so the imported entry's direct-run guard
    // does not call startStandaloneServer. The explicit call below is the only one.
    const module=await importModule();
    if(typeof module.ensureRuntime!=='function'||typeof module.startStandaloneServer!=='function') {
      throw Object.assign(new Error(),{code:'STARTUP_EXPORT_MISSING'});
    }
    startupPhase='runtime_initialization';emit('progress');
    // ensureRuntime caches initialization; startStandaloneServer reuses it.
    const runtime=await module.ensureRuntime();
    startupPhase='listener_start';emit('progress');
    // SMTP startup can return an unavailable status rather than throwing.
    if(!runtime?.smtp?.status?.running)throw Object.assign(new Error(),{code:'SMTP_LISTENER_UNAVAILABLE'});
    const result=await module.startStandaloneServer();
    startupPhase='ready';emit('pass');
    return result;
  } catch(error) {emit('fail',error);throw error;}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  startIngestion().catch(()=>{process.exit(1);});
}
