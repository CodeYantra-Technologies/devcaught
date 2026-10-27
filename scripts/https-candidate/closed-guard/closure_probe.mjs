// Executed only inside a separately approved, network-none disposable container.
// No imports, credentials, application module evaluation or response-body output.
const origin='http://localhost:3000';
const deadline=Date.now()+75000;
const id='00000000-0000-4000-8000-000000000000';
const routes=[['list','GET','/api/messages'],['detail','GET',`/api/messages/${id}`],
  ['raw','GET',`/api/messages/${id}/raw`],['status','GET','/api/status'],
  ['delete','DELETE',`/api/messages/${id}`],['clear','POST','/api/messages/clear'],
  ['test','POST','/api/messages/test']];
const output={schemaVersion:1,result:'BLOCKED',checks:[],compiledGuard:'NOT_VERIFIED',authenticatedCoverage:'NOT_TESTED'};
async function fetchBounded(path,options={}) {
  if(Date.now()>=deadline)throw new Error('deadline');
  return fetch(origin+path,{...options,redirect:'manual',signal:AbortSignal.timeout(Math.min(2000,deadline-Date.now()))});
}
async function limitedBody(response) {
  const reader=response.body?.getReader();if(!reader)return null;
  const parts=[];let size=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>1024)throw new Error('body_limit');parts.push(value);}
    const bytes=new Uint8Array(size);let offset=0;
    for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
  }finally{await reader.cancel().catch(()=>{});}
}
try {
  let ready=false;
  const readinessDeadline=Date.now()+25000;
  while(Date.now()<readinessDeadline) {
    try{const response=await fetchBounded('/api/health');ready=response.status===200;
      await response.body?.cancel();if(ready)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready)throw new Error('readiness');
  output.readiness='PASS';
  for(const identity of ['anonymous','malformed_cookie','forged_headers']) {
    for(const [route,method,path] of routes) {
      const headers={origin,'sec-fetch-site':'same-origin'};
      if(identity==='malformed_cookie')headers.cookie='__Host-devcaught-auth.session_token=invalid';
      if(identity==='forged_headers'){headers['x-user-id']='synthetic-untrusted';headers['x-inbox-id']='synthetic-untrusted';}
      if(method==='POST')headers['content-type']='application/json';
      const response=await fetchBounded(path,{method,headers,...(method==='POST'?{body:'{}'}:{})});
      let pass=false;
      try {
        // Never read a successful or unexpected-status response body.
        if(response.status===503) {
          const body=await limitedBody(response);
          pass=body?.error==='Private inbox unavailable'&&Object.keys(body).length===1&&
            response.headers.get('cache-control')==='private, no-store'&&
            /(?:^|,\s*)Cookie(?:\s*,|$)/i.test(response.headers.get('vary')??'')&&
            response.headers.get('x-content-type-options')==='nosniff';
        }else await response.body?.cancel();
      }finally{await response.body?.cancel().catch(()=>{});}
      output.checks.push({route,identity,status:response.status,result:pass?'PASS':'FAIL'});
      if(!pass){output.result='FAIL';throw new Error('closure');}
    }
  }
  output.result='PASS';
}catch {
  output.reason=output.result==='FAIL'?'unexpected_private_route_response':
    output.readiness==='PASS'?'probe_incomplete':'readiness_unavailable_no_database_fallback';
}
console.log(JSON.stringify(output));
process.exitCode=output.result==='PASS'?0:1;
