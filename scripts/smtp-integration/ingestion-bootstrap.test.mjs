import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startIngestion} from './ingestion-bootstrap.mjs';
import {parseDiagnostics} from './diagnostics.mjs';

test('each startup failure reports its phase and only safe exception identity',async()=>{
  for(const phase of ['module_import','runtime_initialization','listener_start']) {
    const rows=[];
    const error=Object.assign(new TypeError('SYNTHETIC SECRET MESSAGE'),{code:phase==='module_import'?'ERR_MODULE_NOT_FOUND':'EADDRINUSE',stack:'SYNTHETIC SECRET STACK'});
    const module={ensureRuntime:async()=>{if(phase==='runtime_initialization')throw error;return {smtp:{status:{running:true}}};},startStandaloneServer:async()=>{throw error;}};
    await assert.rejects(startIngestion({report:row=>rows.push(row),importModule:async()=>{if(phase==='module_import')throw error;return module;}}));
    const failure=rows.at(-1);
    assert.equal(failure.startupPhase,phase);assert.equal(failure.exceptionName,'TypeError');assert.equal(failure.errorCode,error.code);
    assert.ok(!JSON.stringify(rows).includes('SYNTHETIC SECRET'));
    assert.equal(parseDiagnostics(JSON.stringify(failure))[0].startupPhase,phase);
  }
});
test('unknown names and codes are not echoed; missing SMTP listener is explicit',async()=>{
  const rows=[];
  await assert.rejects(startIngestion({report:row=>rows.push(row),importModule:async()=>{throw {name:'SYNTHETIC_SECRET',code:'SYNTHETIC_SECRET',message:'SYNTHETIC_SECRET'};}}));
  assert.equal(rows.at(-1).exceptionName,null);assert.equal(rows.at(-1).errorCode,null);
  await assert.rejects(startIngestion({report:row=>rows.push(row),importModule:async()=>({ensureRuntime:async()=>({smtp:{status:{running:false}}}),startStandaloneServer:async()=>{assert.fail('must not start HTTP');}})}));
  assert.equal(rows.at(-1).startupPhase,'listener_start');assert.equal(rows.at(-1).errorCode,'SMTP_LISTENER_UNAVAILABLE');
});
test('import guard avoids automatic startup; cached runtime and listener start once',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'devcaught-bootstrap-synthetic-'));
  const path=join(directory,'entry.mjs');
  writeFileSync(path,`
    export let initializations=0, starts=0;let cached;
    export async function ensureRuntime(){return cached??=(initializations++,{smtp:{status:{running:true}}});}
    export async function startStandaloneServer(){starts++;return {runtime:await ensureRuntime(),server:{}};}
    if(import.meta.url===\`file://\${process.argv[1]}\`)void startStandaloneServer();
  `);
  const rows=[];
  const module=await import(pathToFileURL(path).href);
  assert.equal(module.starts,0);
  await startIngestion({report:row=>rows.push(row),importModule:async()=>module});
  assert.equal(module.initializations,1);assert.equal(module.starts,1);
  assert.deepEqual(rows.map(row=>row.startupPhase),['module_import','runtime_initialization','listener_start','ready']);
  const entry=readFileSync(new URL('../../apps/server/src/index.ts',import.meta.url),'utf8');
  assert.match(entry,/if \(import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`\)/);
});
