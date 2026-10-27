import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {emit,category} from '../smtp-integration/diagnostics.mjs';
import {origin,validateManifest,invitationToken,password,readinessCheck,requiredChecks} from './profile.mjs';

let substage='bootstrap:start';
const mark=name=>{substage=`${name}:request`;emit({component:'verifier',verifierSubstage:substage,outcome:'progress',category:'none'});};
const pass=check=>console.log(JSON.stringify({result:'PASS',check}));
const privateHeaders=response=>{
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.match(response.headers.get('vary')??'',/Cookie/i);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
};
async function request(path,{method='GET',cookie,body,expected=200,headers={},privateApi=false}={}) {
  const response=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...headers},
    ...(body?{body:JSON.stringify(body)}:{})});
  emit({component:'verifier',verifierSubstage:substage,outcome:response.status===expected?'observation':'fail',
    category:response.status===expected?'none':'http_status_mismatch',httpStatus:response.status});
  try {
    assert.equal(response.status,expected);
    if(privateApi)privateHeaders(response);
    const cookies=response.headers.getSetCookie();
    // Negative response bodies and raw messages are deliberately never read.
    const value=expected>=200&&expected<300&&response.headers.get('content-type')?.includes('application/json')
      ?await response.json():undefined;
    return {value,cookies};
  }finally{await response.body?.cancel().catch(()=>{});}
}
const ownOrigin={origin,'sec-fetch-site':'same-origin'};
const api=(path,cookie,options={})=>request(path,{cookie,privateApi:true,...options});
async function main() {
  assert.ok(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--readiness-only'));
  const manifest=JSON.parse(readFileSync('/manifest.json','utf8'));validateManifest(manifest);
  mark('auth_ready');let healthy=false;
  for(let i=0;i<30;i++) {
    try{await request('/api/health');healthy=true;break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(healthy);
  const db=new DatabaseSync('/evidence/private-api-acceptance.db',{readOnly:true});
  try {
    const rows=()=>db.prepare('SELECT id,inbox_id FROM messages').all();
    // node:sqlite rows have a null prototype, compare the actual fields instead.
    const initial=rows();assert.equal(initial.length,1);assert.equal(initial[0].id,manifest.legacyId);assert.equal(initial[0].inbox_id,null);
    await api('/api/messages',undefined,{expected:401});
    assert.equal((await request('/api/auth/get-session')).value,null);
    pass(readinessCheck);
    if(process.argv[2]==='--readiness-only')return;

    mark('auth_login');const users=[];
    for(const letter of ['a','b']) {
      const fixture=manifest[letter];
      const credentials={email:fixture.email,password:password(manifest.run,letter)};
      const registered=await request('/api/auth/register-invitation',{method:'POST',headers:ownOrigin,
        body:{...credentials,name:`Synthetic acceptance ${letter}`,invitationToken:invitationToken(manifest.run,letter)}});
      assert.equal(registered.value?.ok,true);
      assert.ok(!registered.cookies.some(cookie=>cookie.startsWith('__Host-devcaught-auth.session_token=')));
      const login=await request('/api/auth/sign-in/email',{method:'POST',headers:ownOrigin,body:credentials});
      const token=login.cookies.find(cookie=>cookie.startsWith('__Host-devcaught-auth.session_token='));
      assert.ok(token);assert.match(token,/;\s*Secure(?:;|$)/i);assert.match(token,/;\s*HttpOnly(?:;|$)/i);
      assert.match(token,/;\s*Path=\/(?:;|$)/i);assert.match(token,/;\s*SameSite=Lax(?:;|$)/i);assert.doesNotMatch(token,/;\s*Domain=/i);
      const cookie=token.split(';')[0];
      const session=(await request('/api/auth/get-session',{cookie})).value;
      assert.equal(session?.user?.email,fixture.email);assert.ok(session?.session?.id);assert.ok(session?.user?.id);
      users.push({cookie,id:session.user.id,email:fixture.email,letter});
    }
    const [a,b]=users;assert.notEqual(a.id,b.id);
    pass(requiredChecks[0]);
    const create=async user=>{
      const {value}=await api('/api/messages/test',user.cookie,{method:'POST',headers:ownOrigin,expected:201,
        body:{from:'synthetic@example.invalid',to:user.email,subject:`SYNTHETIC ${manifest.run} ${user.letter}`,text:'Synthetic acceptance only'}});
      assert.match(value?.id,/^[a-f0-9-]{36}$/);return value.id;
    };
    const idA=await create(a),idB=await create(b);assert.notEqual(idA,idB);
    const persisted=rows();assert.equal(persisted.length,3);
    const inboxA=persisted.find(row=>row.id===idA)?.inbox_id,inboxB=persisted.find(row=>row.id===idB)?.inbox_id;
    assert.ok(inboxA);assert.ok(inboxB);assert.notEqual(inboxA,inboxB);
    mark('auth_isolation');
    for(const [user,own,other] of [[a,idA,idB],[b,idB,idA]]) {
      const list=(await api('/api/messages',user.cookie)).value;
      assert.deepEqual(list.messages.map(message=>message.id),[own]);
      assert.equal((await api('/api/status',user.cookie)).value.messageCount,1);
      assert.equal((await api(`/api/messages/${own}`,user.cookie)).value.id,own);
      await api(`/api/messages/${own}/raw`,user.cookie);
      for(const denied of [other,manifest.legacyId]) {
        await api(`/api/messages/${denied}`,user.cookie,{expected:404});
        await api(`/api/messages/${denied}/raw`,user.cookie,{expected:404});
        await api(`/api/messages/${denied}`,user.cookie,{method:'DELETE',headers:ownOrigin,expected:404});
      }
      assert.equal((await api('/api/messages?q='+encodeURIComponent(`SYNTHETIC PRIVATE API LEGACY ${manifest.run}`),user.cookie)).value.messages.length,0);
    }
    for(const cookie of [undefined,'__Host-devcaught-auth.session_token=invalid']) {
      await api('/api/messages',cookie,{expected:401});
      await api(`/api/messages/${idA}`,cookie,{method:'DELETE',headers:ownOrigin,expected:401});
    }
    // Client identity headers cannot substitute for authentication.
    await api('/api/messages',undefined,{headers:{'x-user-id':a.id,'x-inbox-id':inboxA},expected:401});
    pass(requiredChecks[1]);

    mark('auth_mutation');
    for(const headers of [{},{origin:'http://other.invalid'},{...ownOrigin,'sec-fetch-site':'same-site'}]) {
      await api(`/api/messages/${idA}`,a.cookie,{method:'DELETE',headers,expected:403});
      await api('/api/messages/clear',a.cookie,{method:'POST',headers,expected:403});
      await api('/api/messages/test',a.cookie,{method:'POST',headers,body:{from:'a',to:'b'},expected:403});
    }
    assert.equal((await api('/api/status',a.cookie)).value.messageCount,1);
    assert.equal((await api('/api/status',b.cookie)).value.messageCount,1);
    await api(`/api/messages/${idA}`,a.cookie,{method:'DELETE',headers:ownOrigin});
    await api(`/api/messages/${idA}`,a.cookie,{expected:404});
    await api(`/api/messages/${idB}`,b.cookie);
    await create(a);
    await api('/api/messages/clear',a.cookie,{method:'POST',headers:ownOrigin});
    assert.equal((await api('/api/status',a.cookie)).value.messageCount,0);
    assert.equal((await api('/api/status',b.cookie)).value.messageCount,1);
    await api('/api/messages/clear',b.cookie,{method:'POST',headers:ownOrigin});
    const final=rows();assert.equal(final.length,1);assert.equal(final[0].id,manifest.legacyId);assert.equal(final[0].inbox_id,null);
    pass(requiredChecks[2]);

    mark('auth_logout');
    for(const user of users) {
      await request('/api/auth/sign-out',{method:'POST',cookie:user.cookie,headers:ownOrigin,body:{}});
      // Keep replaying the original signed cookie, not the deletion cookie.
      assert.equal((await request('/api/auth/get-session',{cookie:user.cookie})).value,null);
      await api('/api/messages',user.cookie,{expected:401});
      await api('/api/messages/clear',user.cookie,{method:'POST',headers:ownOrigin,expected:401});
    }
    pass(requiredChecks[3]);
  }finally{db.close();}
}
const deadline=setTimeout(()=>{
  emit({component:'verifier',verifierSubstage:substage,outcome:'fail',category:'timeout',timeout:'verifier_timeout',exitCode:1});process.exit(1);
},120000);
main().then(()=>emit({component:'verifier',verifierSubstage:'complete:start',outcome:'pass',category:'none',exitCode:0}))
  .catch(error=>{emit({component:'verifier',verifierSubstage:substage,outcome:'fail',category:category(error),exitCode:1});process.exitCode=1;})
  .finally(()=>clearTimeout(deadline));
