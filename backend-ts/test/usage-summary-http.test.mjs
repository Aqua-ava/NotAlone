import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,appendFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {launchDsh} from '../src/launch.ts';
import {createStorageFixture} from './usage-summary-fixture.mjs';

test('认证用量合并新旧物理台账，保留取消/未知和本人调用且不重复计数', {timeout:30000}, async t=>{
 const f=await createStorageFixture();let host;
 t.after(async()=>{if(host)assert.equal(await host.terminate(),true);await f.close();});
 const owner=randomUUID(),other=randomUUID(),contact=randomUUID();
 await f.client.query('INSERT INTO owner(id,display_name) VALUES($1,$3),($2,$3)',[owner,other,'合成敏感身份CANARY']);
 await f.client.query('INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,$3)',[owner,contact,'合成联系人CANARY']);
 await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\n`);
 const linked=randomUUID();
 for(const [id,o,tokens] of [[linked,owner,10],[randomUUID(),owner,null],[randomUUID(),other,999]])
  await f.client.query("INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,input_tokens,output_tokens,outcome,called_at) VALUES($1,$2,$3,'synthetic','synthetic-model',$4,$4,'succeeded',now())",[id,o,contact,tokens]);
 async function receipt({dispatch='authorized_unconfirmed',outcome='cancelled',tokens=null,link=null,scope='contact'}={}){
  await f.client.query(`INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,scope_kind,request_id,permit_id,ledger_entry_id,provider,model_name,called_at,dispatch,outcome,input_tokens,output_tokens,cost_status) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic','synthetic-model',now(),$8,$9,$10,$10,'unknown')`,[randomUUID(),owner,scope==='contact'?contact:null,scope,randomUUID(),randomUUID(),link,dispatch,outcome,tokens]);
 }
 await receipt({dispatch:'http_accepted',outcome:'succeeded',tokens:10,link:linked});
 await receipt();await receipt();
 await receipt({dispatch:'http_accepted',outcome:'cancelled'});
 await receipt({dispatch:'response_observed',outcome:'succeeded',tokens:7,scope:'owner_memory'});
 await receipt({dispatch:'not_sent',outcome:'cancelled'});
 const info=join(f.directory,'backend.info');
 host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve('..'),envFilePath:f.envFilePath,infoPath:info,businessHome:f.directory,environment:{NOTALONE_MANAGED_USER_DATA:f.directory}},()=>true);
 let c;for(let i=0;i<150&&host.isRunning();i++){try{c=Object.fromEntries((await readFile(info,'utf8')).trim().split('\n').map(x=>x.split('=')));break;}catch{}await delay(100);}
 assert.ok(c,'官方profile宿主必须就绪');
 const get=async(path,token=c.token,method='GET')=>{const r=await fetch(`http://${c.address}${path}`,{method,headers:{Authorization:`Bearer ${token}`}});return {status:r.status,data:await r.json()};};
 assert.equal((await get('/api/ledger/summary','invalid')).status,401);
 const {status,data}=await get('/api/ledger/summary');assert.equal(status,200);
 assert.equal(data.total_calls,4);assert.equal(data.total_attempts,7);
 assert.equal(data.authorized_unconfirmed_calls,2);assert.equal(data.not_sent_attempts,1);
 assert.equal(data.unknown_usage_calls,2);assert.equal(data.total_input_tokens,null);assert.equal(data.known_input_tokens,17);
 assert.equal(data.total_output_tokens,null);assert.equal(data.known_output_tokens,17);
 assert.equal(data.unknown_cost_calls,4);assert.deepEqual(data.cost_totals,[]);
 assert.equal(data.recent.length,7);assert.equal(data.recent.filter(x=>x.entry_id===linked).length,1);
 assert.equal(data.recent.filter(x=>x.scope_kind==='owner_memory').length,1);
 assert.equal(data.recent.filter(x=>x.dispatch==='authorized_unconfirmed'&&x.outcome==='cancelled').length,2);
 assert.doesNotMatch(JSON.stringify(data),/CANARY|api_key|request_id|permit_id/);
 assert.equal((await get('/api/ledger/summary?owner_id='+other)).status,400);
 assert.equal((await get('/api/ledger/summary',c.token,'POST')).status,405);
 await get('/api/ledger/summary');assert.equal((await f.client.query('SELECT count(*)::int AS n FROM model_call_receipt')).rows[0].n,6);
 // 同一尝试迟到结算只改变只读投影，金额按币种、定价版本及估计状态分组。
 await f.client.query("UPDATE model_call_receipt SET cost_status='known',cost_amount=0.2,currency='USD',pricing_version='synthetic-v1' WHERE ledger_entry_id=$1",[linked]);
 await f.client.query("UPDATE model_call_receipt SET cost_status='estimated',cost_amount=3.3,currency='CNY',pricing_version='synthetic-v2' WHERE scope_kind='owner_memory' AND owner_id=$1",[owner]);
 const settled=(await get('/api/ledger/summary')).data;
 assert.equal(settled.total_calls,4);assert.equal(settled.unknown_cost_calls,2);
 assert.deepEqual(settled.cost_totals,[{status:'estimated',currency:'CNY',pricing_version:'synthetic-v2',amount:'3.3',calls:1},{status:'known',currency:'USD',pricing_version:'synthetic-v1',amount:'0.2',calls:1}]);
 // 读取失败只暴露固定错误；恢复后用户刷新，不派发或改写模型请求。
 await f.client.query('ALTER TABLE model_call_receipt RENAME TO synthetic_receipt_unavailable');
 try{assert.deepEqual(await get('/api/ledger/summary'),{status:503,data:{error:'ledger_summary_unavailable'}});}
 finally{await f.client.query('ALTER TABLE synthetic_receipt_unavailable RENAME TO model_call_receipt');}
 assert.equal((await get('/api/ledger/summary')).data.total_attempts,7);
});
