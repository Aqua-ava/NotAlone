/** 实际主宿主入口验收；固定官方transport只转到本轮loopback SSE。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,readdir,copyFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {sendEvents,useTool} from './reply-service-runtime-support.mjs';
const execute=promisify(execFile);

async function copyVerified(source,target){
 const hashes=[];
 async function visit(from,to,prefix=''){
  await mkdir(to,{recursive:true});
  for(const item of await readdir(from,{withFileTypes:true})){
   if(item.name==='__pycache__'||item.name.endsWith('.pyc'))continue;
   const relative=prefix+item.name,a=join(from,item.name),b=join(to,item.name);
   if(item.isDirectory())await visit(a,b,relative+'/');
   else if(item.isFile()){const bytes=await readFile(a);await writeFile(b,bytes);hashes.push([relative,createHash('sha256').update(bytes).digest('hex')]);}
   else assert.fail('合成产品副本不接受符号链接');
  }
 }
 await visit(source,target);
 return async()=>{for(const[name,hash]of hashes){assert.equal(createHash('sha256').update(await readFile(join(target,name))).digest('hex'),hash);assert.equal(createHash('sha256').update(await readFile(join(source,name))).digest('hex'),hash);}};
}

test('实际host-plugin→host-model-runtime→host-reply：私有A入口、原B消费与零重复HTTP',{timeout:60000},async t=>{
 const db=await createExtractionFixture(),c=db.client;
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID(),task=randomUUID(),step=randomUUID(),worker=randomUUID();
 const text='我喜欢绿茶。',seen=[];let child,exited,output='',connection,legacyPid,stopped=false;
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),name=body.tools[0].name;seen.push({path:req.url,headers:req.headers,body});
  const args=name==='DirectMemoryExtractionOutput'?{scenes:[{scene_name:'饮食偏好',memories:[{text,category:'preference',subject:'contact',topic:'other',source_message_ids:[message],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'原话明确表达偏好'}]}]}:
   {results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:text}]}]};
  const events=[{type:'message_start',message:{id:randomUUID(),model:'deepseek-flash',usage:{input_tokens:3,output_tokens:0}}},{},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
  useTool(events,name,args,randomUUID());sendEvents(res,events);
 });
 async function stop(){
  if(stopped||!child)return;stopped=true;
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  let timer;try{await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('实际主宿主未正常退出，保留现场')),8000))]);}finally{clearTimeout(timer);}
  if(legacyPid){let alive=true;try{process.kill(legacyPid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}assert.equal(alive,false,'唯一Legacy必须正常退出');}
 }
 t.after(async()=>{await stop();provider.closeAllConnections();if(provider.listening)await new Promise(done=>provider.close(done));await db.close();});
 await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成主宿主本人')",[owner]);
 await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 await c.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[randomUUID(),owner,contact]);
 await c.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,status)VALUES($1,$2,'wechat','synthetic','synthetic','active')",[owner,contact]);
 await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contact,'a'.repeat(64)]);
 await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text',$4,'2026-01-01T00:00:00.123456Z')",[message,owner,contact,text]);
 await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{time_iso:'2026-01-01T08:00:00.123456+08:00'}]);
 await c.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)VALUES($1,$2,$3,$4,'import','running','extract_memory',1)",[task,owner,contact,source]);
 await c.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,$2,'extract_memory',3,'running',$3,1,1,now()+interval '5 minutes')",[step,task,worker]);
 const claim={task_id:task,step_id:step,step_name:'extract_memory',worker_id:worker,lease_generation:1};
 const dsn=`host=/tmp dbname=${c.database}`;
 await writeFile(db.envFilePath,`NOTALONE_DATABASE_URL=${dsn}\nNOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\nNOTALONE_EXTRACTION_RUNTIME=typescript\nNOTALONE_DEEPSEEK_API_KEY=synthetic-only\nNOTALONE_EXTRACTION_BATCH_CONCURRENCY=1\nNOTALONE_SKILLS_DIR=${db.directory}/skills\n`,{mode:0o600});
 const project=join(db.directory,'project'),verifyPython=await copyVerified(resolve('../backend/src'),join(project,'backend/src')),verifyMigrations=await copyVerified(resolve('../backend/database'),join(project,'backend/database'));
 await copyFile(new URL('./extraction-host-entry-network-guard.py',import.meta.url),join(project,'backend/src/sitecustomize.py'));
 const home=join(db.directory,'profile-home'),profile=join(home,'profiles/notalone'),info=join(db.directory,'backend.info'),bridgeFile=join(db.directory,'private-bridge.json');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 await writeFile(join(profile,'cordis.patch.yml'),(await readFile('profile/host.patch.yml','utf8')).replace('PLUGIN_PATH',JSON.stringify(resolve('src/host-plugin.ts'))));
 await writeFile(join(home,'host.json'),JSON.stringify({nodeExecutable:process.execPath,projectDirectory:project,envFilePath:db.envFilePath,infoPath:info,businessHome:db.directory,pythonExecutable:join(homedir(),'miniconda3/envs/NotAlone/bin/python'),home,parentPid:process.pid,lockNonce:randomUUID()}));
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 child=spawn(process.execPath,['--import',new URL('./main-host-reply-chain-preload.mjs',import.meta.url).pathname,resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:home,env:{PATH:process.env.PATH,USER:process.env.USER,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NOTALONE_HOST_CONFIG:join(home,'host.json'),NOTALONE_SYNTHETIC_EXTRACTION_BRIDGE_FILE:bridgeFile,NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`},stdio:['pipe','pipe','pipe']});
 exited=once(child,'exit');child.stderr.on('data',part=>output+=part);child.stdout.on('data',part=>output+=part);
 for(let i=0;i<150&&child.exitCode===null&&child.signalCode===null;i++){try{connection=Object.fromEntries((await readFile(info,'utf8')).trim().split('\n').map(line=>line.split('=')));break;}catch{}await delay(100);}
 const safeOutput=()=>output.replaceAll(homedir(),'LOCAL_HOME').replaceAll(resolve('..'),'REPOSITORY').replace(/token=[A-Za-z0-9_-]+/g,'token=<redacted>');
 assert.ok(connection,'实际主宿主应发布握手 '+safeOutput());
 const base=`http://${connection.address}`;
 async function request(path,body,token=connection.token){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json()};}
 const status=await request('/api/runtime/status');legacyPid=status.body.legacyPid;assert.ok(legacyPid);assert.equal(status.body.reply.state,'ready');assert.equal(status.body.ownership.replies,'typescript');
 assert.equal((await request('/internal/extraction/run',{})).status,401);assert.equal(seen.length,0);
 const progressRoute=`/api/contacts/${contact}/memory-processing`;
 const progress=await request(progressRoute);assert.equal(progress.status,200);assert.equal(progress.body.tasks[0].task_id,task);assert.equal(progress.body.tasks[0].status,'extracting');
 const busy=await request(progressRoute+'/resume',{task_id:task,action:'resume'});assert.deepEqual(busy,{status:200,body:{task_id:task,status:'busy'}});assert.equal(seen.length,0);
 assert.equal((await request(progressRoute+'/resume',{task_id:task,action:'retry'})).status,400);assert.equal(seen.length,0);
 const bridge=JSON.parse(await readFile(bridgeFile,'utf8'));assert.equal((await stat(bridgeFile)).mode&0o777,0o600);
 assert.equal(bridge.NOTALONE_EXTRACTION_RUNTIME,'typescript');assert.equal(bridge.NOTALONE_REPLY_RUNTIME,'typescript');assert.equal(bridge.NOTALONE_EXTRACTION_REMOTE_URL,base);assert.ok(bridge.NOTALONE_EXTRACTION_REMOTE_TOKEN!==connection.token);
 const runPython=async mode=>{try{return JSON.parse((await execute(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[resolve('../backend/tests/support/extraction_host_entry.py'),mode,dsn,owner,contact,source,JSON.stringify(claim),base],{cwd:project,env:{PATH:process.env.PATH,USER:process.env.USER,HOME:db.directory,PYTHONPATH:join(project,'backend/src'),PYTHONDONTWRITEBYTECODE:'1',NOTALONE_DISABLE_DOTENV:'1',...bridge},timeout:25000,maxBuffer:1048576})).stdout);}catch(error){throw Error((error.stderr??'').slice(-1800)+'\n'+safeOutput().slice(-1800));}};
 const lost=await runPython('lost');assert.equal(lost.extracted,1);assert.equal(lost.watermark,null);assert.equal(seen.length,2);
 const result=await runPython('run');assert.equal(result.stats.processed_messages,1);assert.equal(result.stats.adopted,1);assert.equal(result.watermark,message);assert.equal(seen.length,2,'新trace恢复A不能重复发送');
 assert.deepEqual(seen.map(row=>row.body.tools[0].name),['DirectMemoryExtractionOutput','SourceVerificationOutput']);
 assert.ok(seen.every(row=>row.path==='/anthropic/v1/messages'&&row.headers['x-api-key']==='synthetic-only'&&row.headers['x-deepseek-harness-user-id']));
 assert.equal((await c.query('SELECT count(*)::int n FROM outbound_ledger_entry')).rows[0].n,2);
 assert.deepEqual((await c.query('SELECT DISTINCT provider FROM model_call_receipt')).rows.map(row=>row.provider),['notalone-deepseek']);
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt r JOIN outbound_ledger_entry l ON l.id=r.ledger_entry_id WHERE r.provider=l.provider AND r.outcome=\'succeeded\'')).rows[0].n,2);
 assert.equal((await c.query("SELECT count(*)::int n FROM memory_extraction_trace_call WHERE ledger_commit_status='committed' AND response_status='returned'")).rows[0].n,2);
 assert.equal((await c.query("SELECT count(*)::int n FROM confirmed_memory WHERE adoption_method='auto'")).rows[0].n,1);
 assert.equal((await c.query("SELECT count(*)::int n FROM memory_extraction_trace_event WHERE stage='batch_end' AND payload?'typescript_a_receipt'")).rows[0].n,1);
 const again=await runPython('run');assert.equal(again.stats.processed_messages,0);assert.equal(seen.length,2);
 assert.equal((await request('/api/runtime/shutdown',{})).body.state,'stopped');await stop();await verifyPython();await verifyMigrations();
 t.diagnostic('实际host-plugin与唯一Legacy已运行；原A/B显式claim验收通过，未据此认证Worker领取/完整队列、App或微信。');
});
