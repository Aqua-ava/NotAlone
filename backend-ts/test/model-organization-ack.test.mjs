/** 真实手录/prepare/Worker/ChatDeepSeek/Unix/PG；吞最终已提交result ACK。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createUnixServer,connect} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const here=resolve(new URL('.',import.meta.url).pathname),root=resolve(here,'../..');
const {createStorageFixture}=await import(pathToFileURL(join(here,'host-storage-fixture.mjs')));
const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python'),node=process.execPath;
const cases=['contact','owner_memory'].flatMap(scope_kind=>[200,400].map(status=>({scope_kind,status,mode:'lost'})));
for(const scope_kind of ['contact','owner_memory']){for(const status of [200,400])cases.push({scope_kind,status,mode:'reconfirm'});cases.push({scope_kind,status:200,mode:'unknown'},{scope_kind,status:200,mode:'legacy'});}
for(const {scope_kind,status,mode} of cases)test(`L2 ${scope_kind} HTTP${status} ${mode}：结果与许可恢复边界`,{timeout:60000},async t=>{
 const f=await createStorageFixture(),temporary=await mkdtemp(join(tmpdir(),'notalone-organization-ack-'));
 let child,host,http,proxy;const sockets=new Set(),hosts=new Set(),protocol=[],postCommitChecks=[];
 const stopHost=async()=>{if(!host||host.exitCode!==null)return;const exit=once(host,'exit');host.stdin.end(JSON.stringify({op:'shutdown'})+'\n');let timer;
  try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic_host_stop_timeout')),5000);})]);}
  finally{clearTimeout(timer);if(host.exitCode===null){host.kill('SIGKILL');await exit;}}};
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}
  if(http)await new Promise(resolve=>http.close(resolve));for(const socket of sockets)socket.destroy();if(proxy)await new Promise(resolve=>proxy.close(resolve));
  await stopHost();for(const h of hosts)assert.notEqual(h.exitCode,null);await f.close();await rm(temporary,{recursive:true,force:true});});
 const config={owner_id:randomUUID(),contact_id:randomUUID(),scope_kind,mode,diagnose:false,socket_path:join(temporary,'permit.sock'),token:'synthetic-permit-token-'.repeat(3),database_url:`dbname=${f.client.database} host=/tmp`};
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[config.owner_id]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[config.contact_id,config.owner_id]);
 const serverPath=join(temporary,'upstream.sock');
 const startHost=async()=>{host=spawn(node,[join(here,'model-organization-ack-host.mjs')],{env:{PATH:'/usr/bin:/bin',HOME:homedir(),USER:process.env.USER},stdio:['pipe','pipe','pipe']});hosts.add(host);
  let stdout='',stderr='';host.stderr.on('data',d=>stderr+=d);const ready=new Promise((resolve,reject)=>{host.stdout.on('data',d=>{stdout+=d;if(stdout.includes('\n'))resolve(JSON.parse(stdout.split('\n')[0]));});host.once('error',reject);host.once('exit',code=>reject(new Error(`synthetic_host_start_failed ${code}: ${stderr}`)));});
  host.stdin.write(JSON.stringify({database:f.client.database,temporary,path:serverPath,token:config.token})+'\n');let timer;
  try{return await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic_host_start_timeout')),5000);})]);}finally{clearTimeout(timer);}};
 assert.equal((await startHost()).state,'ready');
 let drops=0;let dropped;
 proxy=createUnixServer(client=>{const upstream=connect(serverPath);sockets.add(client);sockets.add(upstream);let outgoing='',incoming='',request;
  client.on('error',()=>{});upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
  client.on('data',data=>{outgoing+=data;let n;while((n=outgoing.indexOf('\n'))!==-1){const line=outgoing.slice(0,n+1);outgoing=outgoing.slice(n+1);request=JSON.parse(line);protocol.push({op:request.op,outcome:request.receipt?.outcome,attempt_id:request.receipt?.attempt_id});upstream.write(line);}});
  upstream.on('data',data=>{incoming+=data;let n;while((n=incoming.indexOf('\n'))!==-1){const line=incoming.slice(0,n+1);incoming=incoming.slice(n+1);
   if(!['unknown','legacy'].includes(mode)&&drops===0&&JSON.parse(line).state==='recorded'&&request?.op==='record'&&['succeeded','failed'].includes(request.receipt.outcome)){
    drops++;dropped=request.receipt;postCommitChecks.push(f.client.query('SELECT r.outcome,r.ledger_entry_id,l.id legacy_id,l.outcome legacy_outcome,(l.called_at=r.called_at) called_at_equal FROM model_call_receipt r LEFT JOIN outbound_ledger_entry l ON l.id=r.ledger_entry_id WHERE r.attempt_id=$1',[dropped.attempt_id]));client.destroy();upstream.destroy();return;}
   client.write(line);}});
 });await new Promise(resolve=>proxy.listen(config.socket_path,resolve));
 const seen=[];
 http=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);const payload=JSON.parse(request.messages[1].content);
  const before=(await f.client.query('SELECT r.attempt_id,r.outcome,j.model_calls_used,(SELECT count(*)::int FROM layered_memory_batch b WHERE b.task_id=j.task_id AND b.status=\'running\') running_work FROM model_call_receipt r JOIN layered_memory_job j ON j.task_id=r.request_id ORDER BY r.called_at')).rows;
  seen.push(before);if(mode==='unknown'){res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();res.write('{');setImmediate(()=>res.destroy());return;}const responseStatus=seen.length===1?status:200;res.writeHead(responseStatus,{'content-type':'application/json'});
  if(responseStatus===400){res.end(JSON.stringify({error:{message:'纯合成已知HTTP拒绝',type:'invalid_request_error',code:'synthetic_rejection'}}));return;}
  const answer=payload.proposal?(payload.layer==='l3'?{supported:true,reasons:[],entries:[]}:{items:payload.verification_targets.map(target=>({...target,supported:true,reasons:[]}))}):payload.layer==='l3'?{entries:[]}:{scenarios:[{topic_key:'synthetic-arrangement',title:'合成安排偏好',hint:'合成手录资料',paragraphs:payload.memories.map(memory=>({text:memory.text,references:[{memory_id:memory.memory_id,revision:memory.revision}]}))}]};
  res.end(JSON.stringify({id:'synthetic-organization',object:'chat.completion',created:1,model:'synthetic-model',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(answer)}}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}}));
 });await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));config.base_url=`http://127.0.0.1:${http.address().port}/v1`;
 const run=async phase=>{child=spawn(python,[join(here,'model-organization-ack-fixture.py')],{env:{PATH:'/usr/bin:/bin',HOME:homedir(),PYTHONPATH:join(root,'backend/src'),PYTHONDONTWRITEBYTECODE:'1',NOTALONE_DISABLE_DOTENV:'1'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const exit=once(child,'exit');child.stdin.end(JSON.stringify({...config,phase})+'\n');let timer;
  try{const code=(await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic_worker_timeout')),12000);})]))[0];assert.equal(code,0,stderr);return JSON.parse(stdout);}finally{clearTimeout(timer);}};
 const initial=await run('initial');await Promise.all(postCommitChecks);config.task_id=initial.task_id;
 if(mode==='legacy'){
  assert.equal(drops,0);assert.equal(seen.length,4);assert.equal(initial.worker_outcome,'succeeded');
  assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
  assert.deepEqual((await f.client.query('SELECT model_calls_used,state FROM layered_memory_job')).rows,[{model_calls_used:4,state:'complete'}]);
  t.diagnostic(JSON.stringify({mode,scope_kind,http:seen.length,initial}));return;
 }
 if(mode==='unknown'){
  assert.equal(drops,0);assert.equal(seen.length,1);const journal=JSON.parse(await readFile(`${serverPath}.generation`,'utf8'));
  assert.equal(journal.active.length,0);assert.equal(journal.unknown.length,0);assert.ok(protocol.some(e=>e.op==='settled'));
  assert.deepEqual((await f.client.query('SELECT outcome FROM model_call_receipt')).rows,[{outcome:'unknown'}]);
  await stopHost();const restarted=await startHost();assert.deepEqual(restarted.unknown,[]);
  await f.client.query("UPDATE background_task_step SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE task_id=$1 AND status='running'",[initial.task_id]);
  const recovery=await run('recover');assert.equal(seen.length,1);assert.equal(recovery.worker_outcome,'idle');
  t.diagnostic(JSON.stringify({mode,scope_kind,initial,recovery,journalActive:journal.active.length,restarted,http:seen.length}));return;
 }
 const committed=(await postCommitChecks[0]).rows;assert.equal(drops,1);assert.equal(committed[0].outcome,status===200?'succeeded':'failed');
 if(scope_kind==='contact'){assert.equal(committed[0].legacy_id,dropped.ledger_entry_id);assert.equal(committed[0].called_at_equal,true);assert.equal(committed[0].legacy_outcome,status===200?'succeeded':'run_failed');}
 else{assert.equal(committed[0].legacy_id,null);assert.equal(committed[0].ledger_entry_id,null);}
 assert.equal(seen.length,1);assert.equal(seen[0].length,1);assert.equal(seen[0][0].outcome,'pending');assert.equal(seen[0][0].model_calls_used,1);assert.equal(seen[0][0].running_work,1);
 const journal=JSON.parse(await readFile(`${serverPath}.generation`,'utf8'));
 if(mode==='reconfirm'){
  assert.equal(journal.active.length,0);assert.equal(journal.unknown.length,0);assert.ok(protocol.some(e=>e.op==='settled'));
  const records=protocol.filter(e=>e.attempt_id===dropped.attempt_id&&e.op==='record').map(e=>e.outcome);
  assert.deepEqual(records,['pending',status===200?'succeeded':'failed','unknown',status===200?'succeeded':'failed']);
  await stopHost();const restarted=await startHost();assert.deepEqual(restarted.unknown,[]);assert.deepEqual(initial.unconfirmed_requests,[]);
  t.diagnostic(JSON.stringify({mode,scope_kind,initial,journalActive:journal.active.length,restarted,http:seen.length,records,committed}));return;
 }
 await stopHost();const restarted=await startHost();
 await f.client.query("UPDATE background_task_step SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE task_id=$1 AND status='running'",[initial.task_id]);
 const recovered=await run('recover');
 t.diagnostic(JSON.stringify({scope_kind,status,httpAfterRecovery:seen.length,initial,recovered,journalActive:journal.active.length,journalUnknown:journal.unknown.length,restarted,protocol,committed}));
 assert.equal(seen.length,1,'真实旧job重领不得第二次HTTP');
 assert.ok(restarted.unknown.length===1,'最终结果ACK未知必须留在真实journal而不是由finally的unknown ACK清除');
 assert.ok(recovered.unconfirmed_requests.includes(initial.task_id),'可信宿主必须保留调用端未确认请求');
 assert.equal(recovered.worker_outcome,'idle');
 const old=(await f.client.query('SELECT outcome FROM model_call_receipt WHERE request_id=$1',[initial.task_id])).rows;assert.deepEqual(old,[{outcome:status===200?'succeeded':'failed'}]);
 assert.equal((await f.client.query('SELECT model_calls_used FROM layered_memory_job WHERE task_id=$1',[initial.task_id])).rows[0].model_calls_used,1);
 const next=await run(status===200?'new_input':'new_settings');
 t.diagnostic(JSON.stringify({newPhase:status===200?'new_input':'new_settings',next,http:seen.length,jobs:(await f.client.query('SELECT task_id,model_calls_used,state FROM layered_memory_job ORDER BY created_at')).rows,batches:(await f.client.query('SELECT task_id,status,error_code FROM layered_memory_batch ORDER BY created_at')).rows}));
 assert.notEqual(next.task_id,initial.task_id);assert.equal(next.worker_outcome,'succeeded');assert.equal(seen.length,5,'真实新输入/设置应保留L2/L3提案与核验四次HTTP');
 const all=(await f.client.query('SELECT request_id,outcome,ledger_entry_id FROM model_call_receipt')).rows;assert.equal(all.length,5);assert.equal(new Set(all.map(r=>r.request_id)).size,2);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM outbound_ledger_entry')).rows[0].n,scope_kind==='contact'?5:0);
 assert.equal((await f.client.query('SELECT model_calls_used FROM layered_memory_job WHERE task_id=$1',[next.task_id])).rows[0].model_calls_used,4);
 assert.equal((await f.client.query('SELECT state FROM layered_memory_job WHERE task_id=$1',[next.task_id])).rows[0].state,'complete');
 assert.ok(next.unconfirmed_requests.includes(initial.task_id),'真实新工作不能清掉旧ACK未知门禁');
});
