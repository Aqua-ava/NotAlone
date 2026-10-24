import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';

async function waitFor(check,timeoutMs=10000,intervalMs=20){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  const value=await check();
  if(value)return value;
  await delay(intervalMs);
 }
 throw new Error('synthetic_resume_timeout');
}

test('真实host-plugin将导入与观察resume交给同一TS Worker且不创建任务',{timeout:60000},async t=>{
 const fixture=await createStorageFixture(),owner=randomUUID(),contact=randomUUID();
 const importSource=randomUUID(),binding=randomUUID(),observation=randomUUID();
 const importTask=randomUUID(),observationTask=randomUUID();
 let child,exited,output='',connection,providerCalls=0;
 const provider=createServer((req,res)=>{
  providerCalls++;
  res.writeHead(503,{'content-type':'application/json'});
  res.end(JSON.stringify({error:'synthetic_model_must_not_run'}));
 });
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){
   child.kill('SIGTERM');
   await Promise.race([exited,delay(12000)]);
  }
  if(provider.listening){
   provider.closeAllConnections();
   await new Promise(done=>provider.close(done));
  }
  await fixture.close();
 });

 await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成恢复本人')",[owner]);
 await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成恢复联系人')",[contact,owner]);
 await fixture.client.query(`INSERT INTO source_document
  (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic-resume.jsonl',$4,1)`,[importSource,owner,contact,'c'.repeat(64)]);
 await fixture.client.query(`INSERT INTO conversation_binding
  (id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
  VALUES($1,$2,$3,'wechat','synthetic-resume','synthetic-resume','active')`,[binding,owner,contact]);
 await fixture.client.query(`INSERT INTO local_wechat_observation
  (id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,
   last_local_id,last_cursor,record_count,event_count,memory_enqueued_at)
  VALUES($1,$2,$3,$4,'live','synthetic','synthetic',1,'1',0,1,now())`,
 [observation,owner,contact,binding]);

 await fixture.client.query(`INSERT INTO background_task
  (id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,retry_count,last_error_code,finished_at)
  VALUES($1,$2,$3,$4,'import','failed','parse',1,1,'synthetic_resume',now())`,
 [importTask,owner,contact,importSource]);
 for(const [sequence,name,status] of [
  [1,'parse','failed'],[2,'normalize','failed'],[3,'extract_memory','succeeded'],
  [4,'index','pending'],[5,'verify','pending'],
 ]){
  await fixture.client.query(`INSERT INTO background_task_step
   (task_id,step_name,step_order,status,attempt_count,last_error_code)
   VALUES($1,$2,$3,$4,$5,$6)`,[importTask,name,sequence,status,status==='failed'?1:0,
   status==='failed'?'synthetic_resume':null]);
 }
 await fixture.client.query(`INSERT INTO background_task
  (id,owner_id,contact_id,task_type,status,current_step,message_count,retry_count,last_error_code,finished_at)
  VALUES($1,$2,$3,'observation','failed','index',0,1,'synthetic_resume',now())`,
 [observationTask,owner,contact]);
 for(const [sequence,name,status] of [
  [1,'extract_memory','succeeded'],[2,'index','pending'],[3,'verify','pending'],
 ]){
  await fixture.client.query(`INSERT INTO background_task_step
   (task_id,step_name,step_order,status,attempt_count,last_error_code)
   VALUES($1,$2,$3,$4,0,NULL)`,[observationTask,name,sequence,status]);
 }

 await writeFile(fixture.envFilePath,
  `NOTALONE_DATABASE_URL=host=/tmp dbname=${fixture.client.database}\n`+
  `NOTALONE_OWNER_ID=${owner}\n`+
  'NOTALONE_REPLY_RUNTIME=typescript\n'+
  'NOTALONE_EXTRACTION_RUNTIME=typescript\n'+
  'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n'+
  `NOTALONE_SKILLS_DIR=${join(fixture.directory,'skills')}\n`,{mode:0o600});
 provider.listen(0,'127.0.0.1');
 await once(provider,'listening');

 const project=resolve('..'),home=join(fixture.directory,'profile-home');
 const profile=join(home,'profiles/notalone'),info=join(fixture.directory,'backend.info');
 await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 await writeFile(join(profile,'cordis.patch.yml'),
  (await readFile('profile/host.patch.yml','utf8')).replace('PLUGIN_PATH',JSON.stringify(resolve('src/host-plugin.ts'))));
 await writeFile(join(home,'host.json'),JSON.stringify({
  nodeExecutable:process.execPath,projectDirectory:project,envFilePath:fixture.envFilePath,infoPath:info,
  businessHome:fixture.directory,pythonExecutable:process.env.NOTALONE_TEST_PYTHON||
   join(homedir(),'miniconda3/envs/NotAlone/bin/python'),home,parentPid:process.pid,lockNonce:randomUUID(),
 }));
 child=spawn(process.execPath,[
  '--import',new URL('./main-host-reply-chain-preload.mjs',import.meta.url).pathname,
  resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone',
 ],{cwd:home,env:{
  PATH:process.env.PATH,USER:process.env.USER,LOGNAME:process.env.LOGNAME,HOME:home,DSH_HOME:home,
  DSH_TELEMETRY_DISABLED:'1',NOTALONE_HOST_CONFIG:join(home,'host.json'),
  NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`,
 },stdio:['pipe','pipe','pipe']});
 exited=once(child,'exit');
 child.stdout.on('data',chunk=>output+=chunk);
 child.stderr.on('data',chunk=>output+=chunk);
 connection=await waitFor(async()=>{
  try{
   return Object.fromEntries((await readFile(info,'utf8')).trim().split('\n').map(line=>{
    const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];
   }));
  }catch{return undefined;}
 },20000,100);
 const request=async(path,body)=>{
  const response=await fetch(`http://${connection.address}${path}`,{
   method:body===undefined?'GET':'POST',
   headers:{Authorization:`Bearer ${connection.token}`,'content-type':'application/json'},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),
   signal:AbortSignal.timeout(15000),
  });
  return {status:response.status,data:await response.json()};
 };
 const taskStatus=async taskId=>request(
  `/api/tasks/status?contact_id=${contact}&task_id=${taskId}`,
 );

 const runtime=await request('/api/runtime/status');
 assert.equal(runtime.status,200,output);
 assert.equal(runtime.data.ownership.tasks,'typescript');
 assert.equal(runtime.data.ownership.taskApi,'typescript');
 assert.equal(runtime.data.taskWorker.state,'running');
 const workerId=runtime.data.taskWorker.worker_id;
 assert.match(workerId,/^[a-f0-9-]{36}$/);

 assert.deepEqual(await request(`/api/contacts/${contact}/memory-processing/resume`,{
  task_id:importTask,action:'resume',
 }),{status:200,data:{task_id:importTask,status:'queued'}});
 await waitFor(async()=>(await taskStatus(importTask)).data.status==='succeeded');
 const imported=await taskStatus(importTask);
 assert.equal(imported.data.task_id,importTask);
 assert.equal(imported.data.task_type,'import');

 assert.deepEqual(await request('/api/owner/memory-processing/resume',{
  task_id:observationTask,action:'resume',
 }),{status:200,data:{task_id:observationTask,status:'queued'}});
 await waitFor(async()=>(await taskStatus(observationTask)).data.status==='succeeded');
 assert.equal((await taskStatus(observationTask)).data.task_type,'observation');
 assert.deepEqual((await taskStatus(observationTask)).data.steps.map(step=>step.name),
  ['extract_memory','index','verify']);

 const progress=await request('/api/owner/memory-processing');
 assert.equal(progress.status,200);
 assert.equal(progress.data.scope,'owner');
 assert.deepEqual(new Set(progress.data.tasks.map(task=>task.task_id)),new Set([importTask,observationTask]));
 assert.equal((await fixture.client.query('SELECT count(*)::int AS count FROM background_task')).rows[0].count,2,
  '恢复只能复用原任务，不得创建新任务');
 assert.equal((await request(`/api/tasks/status?contact_id=${randomUUID()}&task_id=${importTask}`)).status,404,
  '恢复不得扩大联系人范围');

 const finalRuntime=await request('/api/runtime/status');
 assert.equal(finalRuntime.data.taskWorker.worker_id,workerId,'领取者必须仍是启动时的唯一TS Worker');
 assert.equal(providerCalls,0,'本恢复只执行确定性步骤，不得调用模型或真实供应商');
 assert.equal((await request('/api/runtime/shutdown',{})).status,200);
 await waitFor(()=>child.exitCode!==null||child.signalCode!==null,15000,50);
});
