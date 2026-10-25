/** 质量入口拒绝路径：所有输入均为合成，供应商请求应为零。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const source=process.env.NOTALONE_SPEC_REVIEW_SOURCE;
if(!source)throw new Error('需要固定源码快照');
const load=path=>import(pathToFileURL(`${source}/backend-ts/${path}`).href);
const {pureTsFixture}=await load('test/pure-ts-runtime-fixture.mjs');
const {syntheticProvider}=await load('test/pure-ts-provider-fixture.mjs');
const evidence={candidate:'ff45f2ec296c4cead326d2ab6f3cf7770c9396ab',checks:[]};
test('正式launcher：具名用途、安装时预算绑定和来源变化均先于物理请求',{timeout:30000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),sourceId=randomUUID(),memory=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成手录',$4,1)",[sourceId,owner,contact,'a'.repeat(64)]);
 await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,$3,'双方曾共同参加合成课程。','common_fact','study',$4,'manual')",[memory,owner,contact,[sourceId]]);
 const provider=await syntheticProvider(t,async(_body,res)=>{res.writeHead(500).end('{}');});
 const environment={NOTALONE_OWNER_ID:owner,NOTALONE_DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_SYNTHETIC_PROVIDER_URL:provider.url};
 const app=await f.start(environment),path=`/api/contacts/${contact}/layered-memory`;
 const state=await app.request(path);assert.equal(state.status,200);assert.equal((await app.request(`${path}/disable`,{settings_generation:state.data.layered_memory.settings_generation})).status,200);
 const input=await app.request(`${path}/quality-input`,{memory_versions:[{memory_id:memory,revision:1}]});assert.equal(input.status,200,JSON.stringify(input));
 const command={case_ids:[input.data.quality_input.case_id],max_http_attempts:8,dataset_version:'independent-guards-v1',data_kind:'fixed_synthetic',purpose_confirmed:true};
 assert.equal((await app.request('/api/layered-memory/quality-runs',{...command,purpose_confirmed:false})).status,400);
 assert.equal((await app.request('/api/layered-memory/quality-runs',{...command,data_kind:'real'})).status,400);
 const created=await app.request('/api/layered-memory/quality-runs',command);assert.equal(created.status,200);const id=created.data.quality_report.report_id;
 const unbound=await app.request(`/api/layered-memory/quality-runs/${id}/execute`,{allow_unreviewed_smoke:true});assert.deepEqual(unbound,{status:503,data:{error:'quality_evaluation_unavailable'}});
 const unchanged=await app.request(`/api/layered-memory/quality-runs/${id}`);assert.equal(unchanged.data.quality_report.state,'prepared');assert.equal(unchanged.data.quality_report.http_attempts_used,0);assert.equal(provider.requests.length,0);
 evidence.checks.push({name:'purpose and fixed-synthetic contract rejected before writes; missing installed budget binding',http_attempts:0,physical_calls:0});
 await app.request('/api/runtime/shutdown',{});assert.equal(await app.host.waitForExit(7000),true);
 const ledger=join(f.directory,'independent-synthetic-budget.sqlite');await writeFile(ledger,'',{mode:0o600});
 const database=new DatabaseSync(ledger);try{database.exec('CREATE TABLE budget(problem TEXT,max_calls INTEGER,deadline REAL,used INTEGER,streak INTEGER); CREATE TABLE rounds(id TEXT PRIMARY KEY,hypothesis TEXT,evidence TEXT,outcome TEXT)');database.prepare('INSERT INTO budget VALUES(?,?,?,0,0)').run('independent-quality-guards',8,Date.now()/1000+120);database.prepare('INSERT INTO rounds VALUES(?,?,NULL,NULL)').run('r1','检查来源失效拒绝路径');}finally{database.close();}
 const restarted=await f.start({...environment,NOTALONE_PROBLEM_BUDGET:ledger,NOTALONE_PROBLEM_ROUND:'r1'});
 await f.client.query("UPDATE confirmed_memory SET text_content='双方曾参加另一门合成课程。',revision=revision+1 WHERE id=$1",[memory]);
 const changed=await restarted.request(`/api/layered-memory/quality-runs/${id}/execute`,{allow_unreviewed_smoke:true});assert.deepEqual(changed,{status:404,data:{error:'quality_evidence_not_found'}});assert.equal(provider.requests.length,0);
 // 原SQL会级联撤销依赖旧版本的case/run；旧身份不能重新认领。
 assert.equal((await f.client.query('SELECT id FROM organization_quality_case WHERE id=$1',[input.data.quality_input.case_id])).rowCount,0);
 assert.equal(Number((await f.client.query('SELECT count(*) AS n FROM organization_quality_attempt')).rows[0].n),0);assert.equal(Number((await f.client.query('SELECT count(*) AS n FROM model_call_receipt')).rows[0].n),0);
 const counted=new DatabaseSync(ledger,{readOnly:true});try{assert.equal(counted.prepare('SELECT used FROM budget').get().used,0);}finally{counted.close();}
 evidence.checks.push({name:'changed source revokes case and rejects old run after restart with installed budget binding',status:changed.status,attempts:0,physical_calls:0});
 await restarted.request('/api/runtime/shutdown',{});assert.equal(await restarted.host.waitForExit(7000),true);
});
test.after(async()=>{if(process.env.NOTALONE_SPEC_REVIEW_RESULT)await writeFile(process.env.NOTALONE_SPEC_REVIEW_RESULT,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});});
