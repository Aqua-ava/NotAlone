/** 明确运行的冻结完整检索对照；只创建合成PG，不启动App/DSH/远端模型。 */
import {readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {PostgresReplyContext} from '../src/reply-context.ts';
import {createLocalEmbedding} from '../src/retrieval-embedding.ts';
import {hybridCandidates} from '../src/retrieval-hybrid.ts';
const python=homedir()+'/miniconda3/envs/NotAlone/bin/python';
const inputPath='/tmp/notalone-retrieval-frozen-input.json',vectorPath='/tmp/notalone-retrieval-frozen-vectors.json';
execFileSync(python,[new URL('./retrieval-frozen-fixture.py',import.meta.url).pathname,inputPath],{timeout:60000});
const data=JSON.parse(await readFile(inputPath,'utf8'));
const report={protocol_version:'migration-comparison-v1',baseline_commit:data.baseline_commit,manifest_sha256:data.manifest_sha256,vector_input_sha256:data.vector_input_sha256,materials_verified:data.material_checks.length,started_at:new Date().toISOString(),seed:102,arm_labels:{A:'frozen_python',B:'typescript'},execution_plan:data.execution_plan,vector_plan:data.vector_plan,recall:[],vectors:[],limitations:['本次旧召回臂为冻结既有InMemory评测，新臂为生产TS上下文加合成PG；不据此比较性能。','不替代DSH profile/HTTP/桌面验收或真实生成模型质量。']};
const fixture=await createStorageFixture();
try{
 const cases=[];
 for(const item of data.recall_cases){
  const owner=randomUUID(),contact=randomUUID(),other=randomUUID(),source=randomUUID(),target=randomUUID();
  await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$3,'合成联系人'),($2,$3,'合成另一联系人')",[contact,other,owner]);
  await fixture.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','冻结合成资料',$4,1)",[source,owner,contact,source.replaceAll('-','').repeat(2)]);
  const addMessage=async(id,text)=>{await fixture.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,'2026-10-01T00:00:00Z')",[id,owner,contact,text]);await fixture.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,$6,'{}')",[randomUUID(),id,owner,contact,source,`synthetic:${id}`]);};
  await addMessage(target,item.query);
  for(const [kind,rows] of [['confirmed_memory',item.memories],['owner_memory',item.owner_memories]])for(const row of rows){
   const id=randomUUID(),message=randomUUID();await addMessage(message,row.text);
   const values=[id,owner,row.text,row.category,row.topic,[message],row.adoption_method,row.confidence,row.valid_at,row.invalid_at,['deleted','invalidated'].includes(row.state)?row.state:'active'];
   if(kind==='confirmed_memory')await fixture.client.query(`INSERT INTO confirmed_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method,confidence,valid_at,invalid_at,status,contact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[...values,row.contact==='other'?other:contact]);
   else await fixture.client.query(`INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method,confidence,valid_at,invalid_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,values);
  }
  cases.push({item,scope:{owner_id:owner,contact_id:contact},target});
 }
 for(const {repeat,index,order} of data.execution_plan){
  const {item,scope,target}=cases[index];
  const runPython=()=>JSON.parse(execFileSync(python,[new URL('./retrieval-frozen-arm.py',import.meta.url).pathname,inputPath,item.name],{timeout:15000}));
  let baseline;
  if(order==='AB') baseline=runPython();
  const context=await new PostgresReplyContext(fixture.client,{overview:false}).build({...scope,reply_request_id:randomUUID(),request:{contact_id:scope.contact_id,continued_from_candidate_id:null,content:{type:'reply_to_message',target_message_id:target,direction:'自然回复',direction_source:'direct_input'}}});
  const contact=context.evidence.filter(e=>e.kind==='confirmed_memory').map(e=>e.text),owner=context.evidence.filter(e=>e.kind==='owner_memory').map(e=>e.text),recalled=[...contact,...owner],expected=item.expect_recalled.length?item.expect_recalled:item.expect_order;
  const result={name:item.name,dimension:item.dimension,recalled,missing:expected.filter(text=>!recalled.includes(text)),unexpected:recalled.filter(text=>!expected.includes(text)),over_budget:contact.length>5||contact.reduce((n,t)=>n+[...t].length,0)>600||owner.length>3||owner.reduce((n,t)=>n+[...t].length,0)>240,order_ok:!item.expect_order.length||JSON.stringify(item.expect_order)===JSON.stringify(recalled)};
  if(order==='BA') baseline=runPython();
  report.recall.push({case_id:item.name,repeat:repeat+1,order,python:baseline,typescript:result,exact:JSON.stringify(result)===JSON.stringify(baseline)});
 }
}finally{await fixture.close();}
const model=await createLocalEmbedding();
try{
 const inputs=[...data.vector_cases.map(row=>row.query),...data.vector_cases.map(row=>row.text)];
 const encoded=model.encode(inputs);
 const pool=data.vector_cases.map((row,i)=>({memory_id:`00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`,text:row.text}));
 for(let repeat=0;repeat<3;repeat++){
  const runPython=async()=>{execFileSync(python,[new URL('./retrieval-frozen-vectors.py',import.meta.url).pathname,inputPath,vectorPath],{timeout:180000});return JSON.parse(await readFile(vectorPath,'utf8'));};
  let expectedVectors;
  if(data.vector_plan[repeat]==='AB')expectedVectors=await runPython();
  const vectors=await model.embed(inputs);
  if(data.vector_plan[repeat]==='BA')expectedVectors=await runPython();
  assert.deepEqual(encoded,{ids:expectedVectors.ids,mask:expectedVectors.mask});
  const expected=expectedVectors.runs[0];
  const ranking=await hybridCandidates(data.vector_cases.map(row=>row.query),pool,async requested=>{assert.deepEqual(requested,inputs);return vectors;});
  for(let i=0;i<data.vector_cases.length;i++){
   let maximum=0;for(const index of [i,i+data.vector_cases.length])for(let j=0;j<512;j++)maximum=Math.max(maximum,Math.abs(vectors[index][j]-expected.vectors[index][j]));
   const actual=ranking[i].map(row=>row.memory_id);
   report.vectors.push({case_id:data.vector_cases[i].case_id,repeat:repeat+1,token_ids_and_mask_exact:true,max_absolute_error:maximum,tolerance:1e-5,vector_pass:maximum<1e-5,ranking_exact:JSON.stringify(actual)===JSON.stringify(expected.ranking[i]),python_ranking:expected.ranking[i],typescript_ranking:actual});
  }
 }
}finally{await model.close();}
report.dimension_gates=JSON.parse(execFileSync(python,[new URL('./retrieval-frozen-summary.py',import.meta.url).pathname,inputPath],{input:JSON.stringify(report),timeout:15000}));
report.ended_at=new Date().toISOString();
report.summary={recall_cases:109,recall_runs_per_arm:report.recall.length,recall_exact:report.recall.filter(r=>r.exact).length,vector_cases:140,vector_runs_per_arm:report.vectors.length,vector_pass:report.vectors.filter(r=>r.vector_pass).length,ranking_exact:report.vectors.filter(r=>r.ranking_exact).length,max_absolute_error:Math.max(...report.vectors.map(r=>r.max_absolute_error)),remote_model_calls:0};
await writeFile(new URL('../../.scratch/dsh-ts-migration/reply-generation/retrieval-frozen-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.summary));
await rm(data.frozen_source_root,{recursive:true,force:true});
await rm(inputPath,{force:true});await rm(vectorPath,{force:true});
assert.ok(report.recall.every(row=>row.exact),'召回与旧完整合同不同，详见报告');
assert.ok(report.vectors.every(row=>row.vector_pass&&row.ranking_exact),'向量或排序不同，详见报告');
