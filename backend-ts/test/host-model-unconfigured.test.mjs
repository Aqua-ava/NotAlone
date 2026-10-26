/** 显式TS未配置也保留真实PG/Unix恢复控制面，不建立模型提供者。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {HostStorage} from '../src/host-storage.ts';
import {startHostModelRuntime} from '../src/host-model-runtime.ts';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';
import {createUnconfiguredFixture} from './host-model-unconfigured-fixture.mjs';

test('显式TS无key可启动真实共享控制面，未配置原因明确且零新收据',{timeout:60000},async t=>{
 const f=await createUnconfiguredFixture(),owner=randomUUID(),business=join(f.directory,'business');
 await mkdir(business,{mode:0o700});let storage,runtime;
 t.after(async()=>{await runtime?.close();await storage?.close();await f.close();});
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成未配置本人')",[owner]);
 await writeFile(f.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${f.database}\nNOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\n`);
 storage=await HostStorage.open(f.options);
 runtime=await startHostModelRuntime({ctx:new Proxy({},{get(){throw Error('缺模型不应安装provider');}}),storage,
  environment:storage.runtimeEnvironment(),businessHome:business,projectDirectory:process.cwd(),
  infoPath:join(f.directory,'backend.info'),envFilePath:f.envFilePath});
 assert.deepEqual(runtime.replyStatus,{state:'unconfigured',reason:'reply_model_unconfigured'});
 const accounting=createHostModelAccounting({route:null,transaction:work=>storage.businessReadTransaction(work),unconfirmedPermitIds:()=>[]});
 assert.deepEqual(await accounting.unconfirmedRequests({owner_id:owner,contact_id:null}),[]);
 assert.ok(runtime.statePath.startsWith(business));
 assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
});

test('未配置route在任何PG或预算写入之前拒绝新预约，metadata与原结算接口仍存在',async()=>{
 let transactions=0;
 const accounting=createHostModelAccounting({route:null,unconfirmedPermitIds:()=>[],
  transaction(){transactions++;throw Error('未配置不能落新预约');}});
 await assert.rejects(accounting.reserve({}),{code:'model_accounting_unconfigured'});
 assert.equal(transactions,0);assert.equal(typeof accounting.unconfirmedRequests,'function');
 assert.equal(typeof accounting.recordReserved,'function');
});

test('显式TS无owner保留未绑定状态与同一共享宿主，不能造UUID或安装provider',{timeout:60000},async t=>{
 const f=await createUnconfiguredFixture(),business=join(f.directory,'business');await mkdir(business,{mode:0o700});
 let storage,runtime;t.after(async()=>{await runtime?.close();await storage?.close();await f.close();});
 await writeFile(f.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${f.database}\nNOTALONE_REPLY_RUNTIME=typescript\nNOTALONE_DEEPSEEK_API_KEY=synthetic-only\n`);
 storage=await HostStorage.open(f.options);
 runtime=await startHostModelRuntime({ctx:new Proxy({},{get(){throw Error('未绑定不应安装provider');}}),storage,
  environment:storage.runtimeEnvironment(),businessHome:business,projectDirectory:process.cwd(),infoPath:join(f.directory,'backend.info'),envFilePath:f.envFilePath});
 assert.deepEqual(runtime.replyStatus,{state:'unconfigured',reason:'reply_owner_unconfigured'});
 assert.ok(runtime.statePath.startsWith(business));
 assert.equal((await storage.setupStatus()).initialized,false);
});

test('TS无key仍原样恢复unknown，保留knownPG与可信owner/contact/NULL查询',{timeout:60000},async t=>{
 const f=await createUnconfiguredFixture(),business=join(f.directory,'business');await mkdir(business,{mode:0o700});
 let storage,runtime,socketDirectory;t.after(async()=>{try{await runtime?.close();}finally{await storage?.close();if(socketDirectory)await rm(socketDirectory,{recursive:true,force:true});await f.close();}});
 const owner=randomUUID(),other=randomUUID(),contact=randomUUID(),foreign=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人'),($2,'合成其他本人')",[owner,other]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人'),($3,$4,'合成其他联系人')",[contact,owner,foreign,other]);
 await writeFile(f.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${f.database}\nNOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\nNOTALONE_EXTRACTION_BATCH_CONCURRENCY=4\n`);
 const identity={runtimeEnvironment:{NOTALONE_EXTRACTION_BATCH_CONCURRENCY:'4'},businessHome:business,infoPath:join(f.directory,'backend.info'),envFilePath:f.envFilePath};
 const seed=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',
  "import {startModelHost} from './src/model-host.ts';import {captureProcessIdentity} from './src/process-identity.ts';const h=await startModelHost(JSON.parse(process.argv[1]));const worker=await captureProcessIdentity(process.pid,process.ppid,process.execPath);const ids=[];for(let i=0;i<4;i++)ids.push((await h.arbiter.acquire('background',undefined,worker)).id);console.log(JSON.stringify({ids,statePath:h.statePath}));process.exit(0);",
  JSON.stringify(identity)],{encoding:'utf8',timeout:10000}));
 socketDirectory=join('/tmp',`na-model-${process.getuid?.()??'local'}-${basename(dirname(seed.statePath))}`);
 const receipts=[{owner,contact,outcome:'pending'},{owner,contact,outcome:'failed'},
  {owner,contact:null,outcome:'pending'},{owner:other,contact:foreign,outcome:'pending'}].map((r,i)=>({...r,request:randomUUID(),attempt:randomUUID(),permit:seed.ids[i]}));
 for(const r of receipts)await f.client.query("INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,provider,model_name,called_at,dispatch,outcome,cost_status,scope_kind) VALUES($1,$2,$3,$4,$5,'deepseek','deepseek-flash',now(),'authorized_unconfirmed',$6,'unknown',$7)",[r.attempt,r.owner,r.contact,r.request,r.permit,r.outcome,r.contact===null?'owner_memory':'contact']);
 storage=await HostStorage.open(f.options);
 runtime=await startHostModelRuntime({ctx:new Proxy({},{get(){throw Error('未配置不安装provider');}}),storage,
  environment:storage.runtimeEnvironment(),businessHome:business,projectDirectory:process.cwd(),infoPath:identity.infoPath,envFilePath:f.envFilePath});
 assert.equal(runtime.statePath,seed.statePath);assert.equal(runtime.recoveredUnknown,3);
 const accounting=createHostModelAccounting({route:null,transaction:work=>storage.businessReadTransaction(work),unconfirmedPermitIds:()=>seed.ids});
 const requests=async(owner_id,contact_id)=>(await accounting.unconfirmedRequests({owner_id,contact_id})).sort();
 assert.deepEqual(await requests(owner,contact),receipts.slice(0,2).map(r=>r.request).sort());
 assert.deepEqual(await requests(owner,null),[receipts[2].request]);assert.deepEqual(await requests(other,foreign),[receipts[3].request]);
 assert.deepEqual(await requests(owner,foreign),[]);
 const rows=(await f.client.query('SELECT attempt_id,outcome,input_tokens,cost_amount,currency,pricing_version FROM model_call_receipt ORDER BY attempt_id')).rows;
 for(const r of receipts){const row=rows.find(row=>row.attempt_id===r.attempt);assert.equal(row.outcome,r.outcome==='pending'?'unknown':r.outcome);
  assert.equal(row.input_tokens,null);assert.equal(row.cost_amount,null);assert.equal(row.currency,null);assert.equal(row.pricing_version,null);}
 assert.equal(rows.length,4);
 await runtime.close();runtime=undefined;
 const journal=JSON.parse(await readFile(seed.statePath,'utf8'));
 assert.equal(journal.host,null);assert.equal(journal.unknown.length,4);
 runtime=await startHostModelRuntime({ctx:new Proxy({},{get(){throw Error('重启未配置不安装provider');}}),storage,
  environment:storage.runtimeEnvironment(),businessHome:business,projectDirectory:process.cwd(),infoPath:identity.infoPath,envFilePath:f.envFilePath});
 assert.equal(runtime.statePath,seed.statePath);
 assert.deepEqual(await requests(owner,contact),receipts.slice(0,2).map(r=>r.request).sort());
 assert.deepEqual((await f.client.query('SELECT attempt_id,outcome,input_tokens,cost_amount,currency,pricing_version FROM model_call_receipt ORDER BY attempt_id')).rows,rows);
});
