import {writeSync} from 'node:fs';

const stages=new Set(['resource and target preflight','normal image and standalone ingestion build','synthetic fixture provisioning','container startup','ingestion startup','verifier execution','application observation','cleanup stop','cleanup fixture revocation','verification']);
const exceptionNames=new Set(['Error','TypeError','SyntaxError','RangeError','ReferenceError','AggregateError']);
const errorCodes=new Set(['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_UNKNOWN_FILE_EXTENSION','ERR_REQUIRE_ESM','ERR_UNSUPPORTED_DIR_IMPORT','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_PACKAGE_IMPORT_NOT_DEFINED','EADDRINUSE','EADDRNOTAVAIL','EACCES','EPERM','ENOENT','ERR_SQLITE_ERROR','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','SMTP_LISTENER_UNAVAILABLE','STARTUP_EXPORT_MISSING']);
const cases=['bootstrap','manifest','web_ready','smtp_ready','sqlite_open','initial','owner_a','owner_b','aliases','unknown','revoked','mixed','database_rcpt_fault','database_data_fault','recovery','retry_first','retry_second','api_guard','complete',
  'sms_ready','sms_pre_fixture','sms_form','sms_json','sms_duplicate','sms_auth','sms_unknown','sms_revoked','sms_isolation','sms_database_fault','sms_recovery','sms_malformed',
  'auth_ready','auth_login','auth_isolation','auth_mutation','auth_logout'];
const steps=['start','connect','ehlo','mail','rcpt','data_command','data_body','sqlite_check','proxy_down','proxy_up','check','request'];
const substages=new Set(['not_started',...cases.flatMap(name=>steps.map(step=>`${name}:${step}`))]);
const categories=new Set(['none','assertion','smtp_status_mismatch','http_status_mismatch','connection_refused','connection_closed','dns_failure','permission','file_missing','postgres_dependency','invalid_json','sqlite_failure','timeout','spawn_failure','child_exit','child_signal','output_limit','unknown']);
const signals=new Set(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGHUP','SIGPIPE']);
export function category(error) {
  return ({ERR_ASSERTION:'assertion',SMTP_STATUS:'smtp_status_mismatch',HTTP_STATUS:'http_status_mismatch',ECONNREFUSED:'connection_refused',SOCKET_CLOSED:'connection_closed',ENOTFOUND:'dns_failure',EAI_AGAIN:'dns_failure',EACCES:'permission',EPERM:'permission',ENOENT:'file_missing',ERR_SQLITE_ERROR:'sqlite_failure',ETIMEDOUT:'timeout',TIMEOUT:'timeout',ENOBUFS:'output_limit'})[error?.code]
    ?? (error?.name==='SyntaxError'?'invalid_json':error?.name==='TimeoutError'?'timeout':'unknown');
}
export function diagnostic(input={}) {
  return {kind:'smtp_integration_diagnostic',component:['runner','verifier','application'].includes(input.component)?input.component:'runner',
    executionStage:stages.has(input.executionStage)?input.executionStage:'verification',
    verifierSubstage:substages.has(input.verifierSubstage)?input.verifierSubstage:'not_started',
    outcome:['start','progress','pass','fail','observation'].includes(input.outcome)?input.outcome:'fail',
    exitCode:Number.isInteger(input.exitCode)&&input.exitCode>=0&&input.exitCode<=255?input.exitCode:null,
    signal:signals.has(input.signal)?input.signal:null,
    timeout:['none','operation_timeout','verifier_timeout','socket_timeout'].includes(input.timeout)?input.timeout:'none',
    category:categories.has(input.category)?input.category:'unknown',
    processName:['web','ingestion','launcher'].includes(input.processName)?input.processName:null,
    shutdownReason:['cleanup_requested','peer_exit','unexpected_exit','startup_failure'].includes(input.shutdownReason)?input.shutdownReason:null,
    applicationPhase:['bootstrap','credentials','volume','proxy','children'].includes(input.applicationPhase)?input.applicationPhase:null,
    applicationState:['running','exited','created','restarting','dead','paused'].includes(input.applicationState)?input.applicationState:null,
    cleanupRequested:input.cleanupRequested===true,
    startupPhase:['module_import','runtime_initialization','listener_start','ready'].includes(input.startupPhase)?input.startupPhase:null,
    exceptionName:exceptionNames.has(input.exceptionName)?input.exceptionName:null,
    errorCode:errorCodes.has(input.errorCode)?input.errorCode:null,
    ...(Number.isInteger(input.httpStatus)&&input.httpStatus>=100&&input.httpStatus<=599?{httpStatus:input.httpStatus}:{})};
}
export function childDiagnostic(result,context={}) {
  const timed=result.error?.code==='ETIMEDOUT';
  return diagnostic({...context,outcome:result.status===0&&!result.error?'pass':'fail',exitCode:result.status,signal:result.signal,
    timeout:timed?(context.component==='verifier'?'verifier_timeout':'operation_timeout'):'none',
    category:timed?'timeout':result.error?(result.error.code==='ENOBUFS'?'output_limit':'spawn_failure'):result.signal?'child_signal':result.status===0?'none':'child_exit'});
}
export function parseDiagnostics(output) {
  return String(output??'').split('\n').flatMap(line=>{
    try {const value=JSON.parse(line);return value.kind==='smtp_integration_diagnostic'?[diagnostic(value)]:[];}catch{return [];}
  });
}
const checks=new Set(['owner delivery ignores spoofed headers; same-owner aliases store once','unknown/revoked recipients and cross-owner DATA reject with 550; no fallback writes','isolated PostgreSQL connection outage returns 451; no fallback; recovery delivers','identical SMTP retry stores two messages (current behavior)','normal private API guard remains 503','final scoped persistence and zero unassigned rows']);
for(const check of [
  'SMS pre-fixture signed absent route returns 404 with zero writes',
  'SMS signed form and JSON deliver to correct isolated inboxes',
  'SMS duplicate returns the original scoped message without another write',
  'SMS invalid authentication unknown revoked and malformed requests never write',
  'SMS PostgreSQL proxy outage returns 503 without writes and recovery delivers',
  'SMS final scoped persistence and zero unassigned rows',
  'AUTH framework readiness anonymous denial and isolated legacy sentinel',
  'AUTH invited users login with secure cookies and real framework session ownership',
  'AUTH own reads cross-owner anonymous and legacy-unassigned denial',
  'AUTH scoped delete clear and mutation-origin enforcement',
  'AUTH logout invalidates session and old cookie replay',
])checks.add(check);
export function parseVerifierEvidence(output) {
  return String(output??'').split('\n').flatMap(line=>{
    try {
      const value=JSON.parse(line);
      if(value.kind==='smtp_integration_diagnostic')return [diagnostic(value)];
      if(value.result!=='PASS'||!checks.has(value.check))return [];
      const row={result:'PASS',check:value.check};
      for(const key of ['ownerA','ownerB','unassigned','retryRows'])if(Number.isSafeInteger(value[key])&&value[key]>=0)row[key]=value[key];
      return [row];
    } catch{return [];}
  });
}
export function emit(input) {writeSync(1,JSON.stringify(diagnostic(input))+'\n');}
