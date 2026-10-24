import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {ReplyScenarioAccess,requireScenarioReceipts} from '../src/reply-context-scenario.ts';
import {readReplyOwnerOverview} from '../src/reply-context-overview.ts';
import {digest} from '../src/contact-overview-evidence.ts';
import {captureLayeredSnapshot,validateLayeredSnapshot,selectLayeredMaterial,requireLayeredMaterial,OWNER_LAYERED_BUDGET} from '../src/reply-context-layered.ts';
test('分层读取必须匹配当前事务完整指纹；旧缓存存在不授予资格',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),memory=randomUUID(),batch=randomUUID(),version=randomUUID(),scenario=randomUUID();
 const scope={owner_id:owner,contact_id:null};await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成人')",[owner]);
 await f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,'清淡饮食','preference','other',$3,'manual')",[memory,owner,[owner]]);
 const overview=await readReplyOwnerOverview(f.client,owner,true),entry=overview.entries[0],manifest=[{...entry.dependency_manifest,organization_timing_sha256:digest(entry.memory.timing)}];
 const {execFileSync}=await import('node:child_process'),{homedir}=await import('node:os');
 const oracle=`import json,sys,psycopg\nfrom uuid import UUID\nfrom psycopg.rows import dict_row\nfrom notalone.persistence.memory_overview import PostgresRelationshipOverviewStore\nfrom notalone.persistence.layered_memory import PostgresLayeredMemoryStore\nx=json.load(sys.stdin)\nassert x['database'].startswith('notalone_ts_host_') and x['database'].endswith('_test')\nurl='host=/tmp dbname='+x['database']\nwith psycopg.connect(url,row_factory=dict_row) as c:\n o=PostgresRelationshipOverviewStore(url).read_owner_in_transaction(c,UUID(x['owner']),organization=True)\n print(json.dumps(PostgresLayeredMemoryStore._manifest(c,None,o.entries),default=str))`;
 const expectedManifest=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',oracle],{input:JSON.stringify({database:f.client.database,owner}),env:{...process.env,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:15000}));
 assert.deepEqual(manifest,expectedManifest);

 await f.client.query("UPDATE layered_memory_state SET enabled=true,status='ready',settings_generation=1,organization_generation=1 WHERE owner_id=$1 AND contact_id IS NULL",[owner]);
 await f.client.query("INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at) VALUES($1,$2,NULL,1,'synthetic','succeeded',$3,'{}',$4,now())",[batch,owner,JSON.stringify(manifest),[owner,memory]]);
 await f.client.query("INSERT INTO scenario_document_version(id,owner_id,contact_id,scenario_id,batch_id,organization_generation,schema_version,title,hint,paragraphs,created_at) VALUES($1,$2,NULL,$3,$4,1,1,'饮食','合成提示',$5,now())",[version,owner,scenario,batch,JSON.stringify([{text:'偏好清淡',references:[{memory_id:memory,revision:1}]}])]);
 await f.client.query("INSERT INTO layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,dependency_ids) VALUES($1,NULL,1,2,$2,$3)",[owner,[version],[owner,memory]]);
 const snapshot=await captureLayeredSnapshot(f.client,scope);assert.ok(snapshot);assert.equal(await validateLayeredSnapshot(f.client,snapshot),true);
 const material=selectLayeredMaterial(snapshot,OWNER_LAYERED_BUDGET);assert.equal(JSON.parse(material.payload_json).directory[0].paragraph_count,1);await requireLayeredMaterial(f.client,scope,material,OWNER_LAYERED_BUDGET);
 const access=new ReplyScenarioAccess(material);
 const [one,two]=await Promise.all([access.read(f.client,{scenario_id:scenario,paragraph_index:0}),access.read(f.client,{scenario_id:scenario,paragraph_index:0})]);
 assert.equal(one.status,'succeeded');assert.equal(one.document.paragraphs[0].text,'偏好清淡');assert.equal(two.status,'duplicate');assert.equal((await access.read(f.client,{scenario_id:scenario,paragraph_index:0})).status,'budget_exceeded');requireScenarioReceipts(material,access.receipts);
 const tampered=access.receipts;tampered[0].budget.used_characters=0;assert.throws(()=>requireScenarioReceipts(material,tampered),/回执/);
 assert.equal(await validateLayeredSnapshot(f.client,{...snapshot,dependency_ids:[owner]}),false);
 assert.equal(await validateLayeredSnapshot(f.client,{...snapshot,scenarios:[{...snapshot.scenarios[0],title:'伪造标题'}]}),false);
 await f.client.query("UPDATE layered_memory_batch SET input_manifest=jsonb_set(input_manifest,'{0,record_sha256}','\"changed\"') WHERE id=$1",[batch]);assert.equal(await captureLayeredSnapshot(f.client,scope),null);await assert.rejects(requireLayeredMaterial(f.client,scope,material,OWNER_LAYERED_BUDGET),/整理资料已变化/);
});
test('分层材料预算与旧Python选择器逐字段及JSON字符对齐',async()=>{
 const {execFileSync}=await import('node:child_process'),{homedir}=await import('node:os');
 const snapshot={schema_version:2,scope:{owner_id:randomUUID(),contact_id:null},settings_generation:1,organization_generation:2,scenarios:Array.from({length:6},(_,i)=>({scenario_id:randomUUID(),version_id:randomUUID(),title:'合成主题'+i,hint:'中文😀提示'.repeat(12),paragraph_count:3})),dependency_ids:[],profile_version_id:randomUUID(),profile_entries:[{text:'中文😀资料',kind:'inference',uncertainty:'未知',references:[]}]};
 const script=`import json,sys\nfrom uuid import UUID\nfrom notalone.scopes import OwnerScope\nfrom notalone.memory.layered import LayeredMemorySnapshot,ScenarioDirectoryEntry\nfrom notalone.reply.layered_context import LayeredReplyBudget,ScenarioReadBudget,select_material\nx=json.load(sys.stdin)\ns=x['snapshot']\ns['scope']=OwnerScope(UUID(s['scope']['owner_id']))\ns['scenarios']=tuple(ScenarioDirectoryEntry(**{**v,'scenario_id':UUID(v['scenario_id']),'version_id':UUID(v['version_id'])}) for v in s['scenarios'])\ns['dependency_ids']=tuple(s['dependency_ids'])\ns['profile_entries']=tuple(s['profile_entries'])\ns['profile_version_id']=UUID(s['profile_version_id'])\nb=x['budget'];b['scenario_read']=ScenarioReadBudget(**b['scenario_read'])\nm=select_material(LayeredMemorySnapshot(**s),LayeredReplyBudget(**b))\nprint(json.dumps(m.payload_json if m else None,ensure_ascii=False))`;
 for(const characters of [500,800,1600]){const budget={...OWNER_LAYERED_BUDGET,characters};const expected=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',script],{input:JSON.stringify({snapshot,budget}),env:{...process.env,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:10000}));assert.equal(selectLayeredMaterial(snapshot,budget)?.payload_json??null,expected);}
});
