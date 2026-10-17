import { algorithm } from './algorithm-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

test('旧资料升级明确预算与批次修订，轮询不取消批准，切换范围丢弃迟到正文', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-upgrade-'));
  try {
    const output = path.join(owned, 'controller.mjs');
    await build({ entryPoints: ['src/main/memory-upgrade/controller.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { MemoryUpgradeController } = await import(pathToFileURL(output).href);
    const contactId = randomUUID(), jobId = randomUUID(), calls = [];
    let changed, release;
    let contactState = { selectedContactId: contactId, scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId }] };
    const contacts = { getState: () => contactState, onStateChanged: (listener) => { changed=listener; } };
    const job = { algorithm, job_id: jobId, scope: {kind:'contact',contact_id:contactId}, revision:2,state:'active',
      budget:{message_limit:10,batch_size:5,model_calls:4},model_calls_used:0,batches:[] };
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => {}, requestJson: async (request) => {
      calls.push(request);
      return request.method==='GET' ? {generation:1,data:{jobs:[]}} : new Promise((resolve) => {release=resolve;});
    } };
    const controller = new MemoryUpgradeController(backend, contacts);
    const selection = {kind:'contact',contactId,scopeRevision:1};
    await controller.refresh(selection);
    const preparing = controller.prepare({...selection,budget:job.budget,confirmed:true});
    assert.deepEqual(calls[1].body.scope, {kind:'contact',contact_id:contactId});
    assert.deepEqual(calls[1].body.budget,job.budget);
    assert.match(calls[1].body.operation_key,/^[0-9a-f-]{36}$/);
    await controller.refresh(selection);
    assert.equal(calls.length,2);
    assert.equal(calls[1].signal.aborted,false);
    contactState={...contactState,selectedContactId:null,scopeRevision:2}; changed();
    release({generation:1,data:job}); await preparing;
    assert.deepEqual(controller.getState().jobs,[]);
    assert.equal(controller.getState().contactId,null);
    assert.equal(controller.getState().phase,'idle');
  } finally { await rm(owned,{recursive:true,force:true}); }
});

test('批准只携带用户看到的批次修订，独立本人范围不带联系人过滤，断连及删除不能复活比较', async () => {
  const owned=await mkdtemp(path.join(tmpdir(),'notalone-upgrade-approve-'));
  try {
    const output=path.join(owned,'controller.mjs');
    await build({entryPoints:['src/main/memory-upgrade/controller.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
    const {MemoryUpgradeController}=await import(pathToFileURL(output).href);
    const contactId=randomUUID(),batchId=randomUUID(),jobId=randomUUID(),calls=[];
    let generation=1,backendChanged,release;
    const contacts={getState:()=>({selectedContactId:contactId,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId}]}),onStateChanged:()=>{}};
    const job={algorithm, job_id:jobId,scope:{kind:'owner',contact_id:null},revision:4,state:'active',budget:{message_limit:20,batch_size:10,model_calls:8},model_calls_used:2,
      batches:[{algorithm,batch_id:batchId,revision:2,state:'ready',number:1,contact_id:contactId,message_count:1,comparison:null,task_status:'succeeded',current_step:'verify_upgrade_preview',error_code:null}]};
    const backend={getConnectionGeneration:()=>generation,onStateChanged:listener=>{backendChanged=listener;},requestJson:async request=>{
      calls.push(request);return request.method==='GET'?{generation,data:{jobs:[job]}}:new Promise(resolve=>{release=resolve;});
    }};
    const controller=new MemoryUpgradeController(backend,contacts);controller.selectScope('owner');
    const selection={kind:'owner',contactId:null,scopeRevision:1};await controller.refresh(selection);
    assert.equal(calls[0].path,'/api/memory-upgrades?scope=owner');
    const polling=controller.refresh(selection);
    assert.equal(controller.getState().jobs.length,1,'同修订轮询不得卸载含用户批次选择的卡片');
    await polling;
    calls.pop();
    const command={...selection,jobId,expectedRevision:4,confirmed:true,action:'apply',batches:[{batch_id:batchId,expected_revision:2}]};
    await assert.rejects(controller.operate({...command,batches:[{batch_id:batchId,expected_revision:1}]}));
    assert.equal(calls.length,1);
    const applying=controller.operate(command);
    assert.equal(calls[1].body.expected_revision,4);assert.deepEqual(calls[1].body.batches,command.batches);
    controller.invalidate();generation=undefined;backendChanged();
    release({generation:1,data:{...job,batches:[{...job.batches[0],state:'applied'}]}});await applying;
    assert.deepEqual(controller.getState().jobs,[]);assert.equal(controller.getState().phase,'idle');
    generation=2;backendChanged();await controller.refresh(selection);assert.equal(controller.getState().jobs.length,1);
  } finally {await rm(owned,{recursive:true,force:true});}
});
