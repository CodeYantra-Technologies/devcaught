import {getRequest} from '@tanstack/react-start/server';
import {createPrivateInboxApi,type PrivateInboxOperation} from '../../../src/lib/inbox/private-inbox-api.ts';
import {PRIVATE_INBOX_POSTGRES_VERIFIED} from '../../../src/lib/inbox/private-inbox-release.ts';
import {privateInboxTargetReady} from '../../../src/lib/inbox/private-inbox-readiness.ts';
import {requirePrivateInbox} from '../../../src/lib/auth/private-inbox.server.ts';
import {verifiedSessionUser} from '../../../src/lib/auth/session-policy.ts';
import {handleAuthRequest} from '../../../src/lib/auth/http-handler.ts';
import {openInboxStore} from '../../../apps/server/src/store/sqlite.ts';
import {normalizeTestEmail} from '../../../apps/server/src/ingest/normalizeEmail.ts';
import {auth,authDatabase,manifest,cancelled,checkRole} from './auth.server.ts';

if(PRIVATE_INBOX_POSTGRES_VERIFIED!==false)throw new Error('Shipped guard must stay closed');
const {store}=openInboxStore('/app/data/private-api-acceptance.db',{requirePersistent:true});
const marker=`SYNTHETIC PRIVATE API LEGACY ${manifest.run}`;
if(!store.get(manifest.legacyId)) {
  if(store.count()!==0)throw new Error('Acceptance volume must start empty');
  store.insert({...normalizeTestEmail({from:'synthetic@example.invalid',to:'synthetic@example.invalid',subject:marker,text:marker}),
    id:manifest.legacyId,detections:[]});
}
// This literal exists only in this separately built test entry, never in the
// production adapter. No request header, cookie, browser or env flag activates it.
const api=createPrivateInboxApi({postgresVerified:true,openStore:async()=>store,
  resolveInbox:async()=>{
    const request=getRequest();if(!request)throw new Error('Framework context required');
    const user=await verifiedSessionUser(auth,request.headers,true);
    if(!user||![manifest.a.email,manifest.b.email].includes(user.email??''))return null;
    try{return await requirePrivateInbox();}
    catch(error){if(error instanceof Error&&error.name==='UnauthorizedError')return null;throw error;}
  }});

export async function handleAcceptanceRequest(request:Request):Promise<Response> {
  // Positive API cases cannot pass through an injected Request/user identity.
  const context=getRequest();
  if(!context||context.url!==request.url||context.headers.get('cookie')!==request.headers.get('cookie'))throw new Error('Framework context mismatch');
  await checkRole();
  if(await cancelled())return Response.json({error:'Acceptance cancelled'},{status:503});
  if(!await privateInboxTargetReady(authDatabase))return Response.json({error:'Acceptance schema unavailable'},{status:503});
  const path=new URL(request.url).pathname;
  if(path==='/api/health')return Response.json({ok:true});
  if(path.startsWith('/api/auth/')) {
    if(request.method==='POST'&&['/api/auth/sign-in/email','/api/auth/register-invitation'].includes(path)) {
      // Restrict this isolated auth instance to the two invited fixture emails.
      const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
      if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>16384){await reader.cancel();return Response.json({error:'Too large'},{status:413});}chunks.push(value);}
      const bytes=Buffer.concat(chunks);let body;
      try{body=JSON.parse(bytes.toString('utf8'));}catch{return Response.json({error:'Invalid JSON'},{status:400});}
      if(![manifest.a.email,manifest.b.email].includes(body?.email))return Response.json({error:'Fixture identity required'},{status:403});
      request=new Request(request.url,{method:request.method,headers:request.headers,body:bytes});
    }
    return handleAuthRequest(request,auth);
  }
  let operation:PrivateInboxOperation|undefined,id='';
  if(path==='/api/messages')operation='list';else if(path==='/api/status')operation='status';
  else if(path==='/api/messages/test')operation='test';else if(path==='/api/messages/clear')operation='clear';
  else {const match=path.match(/^\/api\/messages\/([^/]+)(\/raw)?$/);if(match){id=decodeURIComponent(match[1]);operation=match[2]?'raw':request.method==='DELETE'?'delete':'detail';}}
  return operation?api(request,operation,id):Response.json({error:'Not found'},{status:404});
}
