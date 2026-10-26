/** 原公开管理合同的隔离 PG/HTTP seam；只创建随机合成库。 */
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {prepareDatabaseSchema} from '../src/platform/database/schema-prepare.ts';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';
import {createLayeredMemoryManagement} from '../src/memory/records/documents/service.ts';
import {L2ScenarioService} from '../src/memory/scenarios/service.ts';
import {DEFAULT_L2_SCENARIO_BUDGET} from '../src/memory/scenarios/workspace.ts';
import {renderProfile} from '../src/memory/profiles/workspace.ts';

export async function managementFixture(t, options = {}) {
  const name = `notalone_layered_${randomUUID().replaceAll('-', '')}_test`;
  const admin = new pg.Client({host:'/tmp', database:'postgres'});
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const result = await prepareDatabaseSchema({databaseUrl:`host=/tmp dbname=${name}`,
    migrationsDirectory:new URL('../database/migrations/', import.meta.url).pathname, environment:{}});
  if (result.code !== 'ready') throw new Error(`合成结构准备失败：${result.code}`);
  const pool = new pg.Pool({host:'/tmp', database:name, max:6});
  const transaction = async work => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {await client.query('ROLLBACK'); throw error;}
    finally {client.release();}
  };
  const ownerId=randomUUID(), contactId=randomUUID(), memoryId=randomUUID(), sourceId=randomUUID(),ownerMemoryId=randomUUID();
  await pool.query("INSERT INTO owner(id,display_name) VALUES($1,'合成所有者')", [ownerId]);
  await pool.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')", [contactId,ownerId]);
  await pool.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'manual','合成手录',$4,1)`, [sourceId,ownerId,contactId,'a'.repeat(64)]);
  await pool.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,$3,'双方曾共同参加合成课程。','common_fact','study',$4,'manual')`, [memoryId,ownerId,contactId,[sourceId]]);
  await pool.query(`INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,'本人曾参加合成课程。','common_fact','study',$3,'manual')`,[ownerMemoryId,ownerId,[ownerId]]);
  const store = new ExtractionTaskStore(pool);
  const manager = createLayeredMemoryManagement({ownerId,transaction,...options});
  const server=createServer(async (req,res) => {
    try {
      const chunks=[];
      for await (const chunk of req) chunks.push(chunk);
      const body=chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const result=await manager.handle(req.method,new URL(req.url,'http://127.0.0.1'),body,new AbortController().signal);
      res.writeHead(result?.status??404,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(result?.body??{error:'not_found'}));
    } catch {res.writeHead(500);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  });
  return {pool,transaction,store,manager,ownerId,contactId,memoryId,sourceId,ownerMemoryId,now:options.now,
    scope:{owner_id:ownerId,contact_id:contactId},taskScope:{ownerId,contactId},
    async request(action='',body,contact=contactId,method=body===undefined?'GET':'POST') {
      const prefix=contact===null?'/api/memories/owner':`/api/contacts/${contact}`;
      const response=await fetch(`http://127.0.0.1:${server.address().port}${prefix}/layered-memory${action?`/${action}`:''}`,{
        method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json()};
    },
  };
}

/** 让既有模型边界返回可独立逐字核验的合成材料，不预置任何任务或派生版本。 */
export async function completeManagementTask(f,state,{owner=false,beforeCall,topic='synthetic-course'}={}) {
  const scope=owner?{owner_id:f.ownerId,contact_id:null}:f.scope;
  const taskScope={ownerId:scope.owner_id,contactId:scope.contact_id};
  const memoryId=owner?f.ownerMemoryId:f.memoryId;
  const text=owner?'本人曾参加合成课程。':'双方曾共同参加合成课程。';
  const claim=await f.store.claim(taskScope,{taskId:state.work_id,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory']});
  if(!claim)throw new Error('正式覆盖任务必须可领取');
  let calls=0;
  const model={async call(input){
    calls++;await input.requireCurrent();await beforeCall?.(calls,input);
    const tool=(name,args)=>({blocks:[{type:'tool-call',id:`management-${calls}`,name,arguments:JSON.stringify(args)}],receipt_id:randomUUID()});
    if(calls===1)return tool('write',{path:'course.md',content:`<!-- META ${JSON.stringify({topic_key:topic,title:'合成课程',hint:'共同课程经历'})} -->\n\n${text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memoryId,revision:1}])} -->`});
    if(calls===2)return {blocks:[],receipt_id:randomUUID()};
    if(calls===3)return tool('ScenarioVerificationOutput',{results:[{scenario_index:0,paragraph_index:0,supported:true,evidence:[{memory_id:memoryId,quote:text}]}]});
    if(calls===4)return tool('write',{path:'profile.md',content:renderProfile({entries:[{
      text,kind:'fact',section:'life_context',basis:'实际记忆明确记载课程经历。',temporal_status:'historical',uncertainty:'',
      references:[{memory_id:memoryId,revision:1}],
    }]})});
    if(calls===5)return {blocks:[],receipt_id:randomUUID()};
    if(calls===6)return tool('ProfileVerificationOutput',{results:[{entry_index:0,supported:true,evidence:[{memory_id:memoryId,quote:text}]}]});
    throw new Error('unexpected_synthetic_model_call');
  }};
  const service=new L2ScenarioService({transaction:f.transaction,model,budget:DEFAULT_L2_SCENARIO_BUDGET,
    binding:{provider:'synthetic',model:'synthetic',maxTokens:1024,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:128_000,safety_margin_tokens:512},...(f.now?{now:f.now}:{})});
  const result=await service.run(scope,{task_id:claim.taskId,step_id:claim.stepId,step_name:'organize_memory',
    worker_id:claim.workerId,lease_generation:claim.leaseGeneration},new AbortController().signal);
  await f.store.complete(claim,result.processed_count);
  return {result,calls,claim,service};
}
