/** 合成质量租约的实际PG/官方profile/Unix许可/HTTP；不读取业务配置。 */
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createServer as createSocketServer,createConnection} from 'node:net';
import {once} from 'node:events';
import {spawn,fork,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,chmod,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {prepareDatabaseSchema} from '../src/schema-prepare.ts';
import {OrganizationQualityStore,qualityInputSourceRef} from '../src/organization-quality-store.ts';
import {createOrganizationQualityContract} from '../src/organization-quality-contract.ts';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';
import {ModelPermitArbiter} from '../src/model-permits.ts';
import {startModelPermitServer} from '../src/model-permit-server.ts';

export async function qualityModelFixture(t,options={}) {
  const directory=await mkdtemp(join(tmpdir(),'na-quality-model-'));
  await chmod(directory,0o700);
  const database=`notalone_quality_model_${randomUUID().replaceAll('-','')}_test`;
  const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
  let pool,permit,http,child,exited,proxy;
  const proxySockets=new Set();let settledAfterCorruptAck=0;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    await exited;
    for(const socket of proxySockets)socket.destroy();
    if(proxy)await new Promise(done=>proxy.close(done));
    await permit?.shutdown();
    if(http){http.closeAllConnections();await new Promise(done=>http.close(done));}
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);await admin.end();
    await rm(directory,{recursive:true,force:true});
  });
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const prepared=await prepareDatabaseSchema({databaseUrl:`host=/tmp dbname=${database}`,
    migrationsDirectory:new URL('../../backend/database/migrations/',import.meta.url).pathname,environment:{}});
  if(prepared.code!=='ready')throw new Error('quality_fixture_schema_failed');
  pool=new pg.Pool({host:'/tmp',database,max:6});
  const transaction=async work=>{
    const client=await pool.connect();
    try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  };
  const ownerId=randomUUID(),contactId=randomUUID(),memoryId=randomUUID(),sourceId=randomUUID(),ownerMemoryId=randomUUID();
  await pool.query("INSERT INTO owner(id,display_name)VALUES($1,'合成用户')",[ownerId]);
  await pool.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contactId,ownerId]);
  await pool.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','合成手录',$4,1)",[sourceId,ownerId,contactId,'a'.repeat(64)]);
  await pool.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)VALUES($1,$2,$3,'双方曾共同参加合成课程。','common_fact','study',$4,'manual')",[memoryId,ownerId,contactId,[sourceId]]);
  await pool.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method)VALUES($1,$2,'本人曾参加合成课程。','common_fact','study',$3,'manual')",[ownerMemoryId,ownerId,[ownerId]]);
  for(const contact of [contactId,null])await pool.query('INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation)VALUES($1,$2,true,1) ON CONFLICT (owner_id,scope_kind,scope_key) DO UPDATE SET enabled=true,settings_generation=1',[ownerId,contact]);
  const contract=createOrganizationQualityContract({provider:'synthetic-route',request_model:'synthetic-model',verifier_provider:'synthetic-route',verifier_model:'synthetic-model',...options.contractOverrides});
  if(options.caseLimit!==undefined)contract.budget.max_model_calls=options.caseLimit;
  const store=new OrganizationQualityStore({transaction,contract});
  const accounting=createHostModelAccounting({transaction,provider:'synthetic-route',model:'synthetic-model',unconfirmedPermitIds:()=>permit?.unconfirmedPermitIds()??[]});
  const socket=join(directory,'permit.sock'),token='synthetic-quality-model-token-'.repeat(3);
  let arbiter=new ModelPermitArbiter(2);
  const buildPermit=async()=>{
    if(!options.hostInChild)return startModelPermitServer({path:socket,token,arbiter,accounting:{...accounting,
      reserveQuality:async(...args)=>{await accounting.reserveQuality(...args);await options.afterReserve?.(pool);}}});
    const host=fork(new URL('./quality-model-permit-host.mjs',import.meta.url),[],{execArgv:[],
      env:{PATH:process.env.PATH,USER:process.env.USER,LOGNAME:process.env.LOGNAME,
        NOTALONE_QUALITY_PERMIT_CONFIG:JSON.stringify({database,socket,token})},stdio:['ignore','pipe','pipe','ipc']});
    const stopped=once(host,'exit'),pending=new Map();let ids=[];
    await new Promise((done,reject)=>{
      const timer=setTimeout(()=>reject(new Error('quality_permit_host_start_failed')),5000);
      host.on('message',message=>{ids=message.ids??ids;if(message.ready){clearTimeout(timer);done();}
        if(message.id){pending.get(message.id)?.();pending.delete(message.id);}});
      host.once('exit',()=>{clearTimeout(timer);reject(new Error('quality_permit_host_exit'));});
    });
    const rpc=op=>new Promise((done,reject)=>{
      const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('quality_permit_rpc_failed'));},5000);
      pending.set(id,()=>{clearTimeout(timer);done();});host.send({id,op});
    });
    return {unconfirmedPermitIds:()=>ids,refresh:()=>rpc('snapshot'),async shutdown(){if(host.exitCode===null&&host.signalCode===null){await rpc('shutdown');await stopped;}}};
  };
  permit=await buildPermit();
  let exposedSocket=socket;
  if(options.corruptReserveAck){
    exposedSocket=join(directory,'proxy.sock');
    proxy=createSocketServer(local=>{
      const remote=createConnection(socket),pair=[local,remote];let buffer='',corrupted=false;
      for(const stream of pair){proxySockets.add(stream);stream.on('error',()=>pair.forEach(item=>item.destroy()));stream.once('close',()=>{proxySockets.delete(stream);pair.forEach(item=>item.destroy());});}
      local.on('data',data=>{if(corrupted&&data.toString().includes('"op":"settled"'))settledAfterCorruptAck++;remote.write(data);});
      remote.on('data',data=>{buffer+=data.toString();let end;while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        if(JSON.parse(line).state==='reserved'){corrupted=true;local.write('lost-valid-quality-reserve-ack\n');}else local.write(`${line}\n`);
      }});
    });
    await new Promise(done=>proxy.listen(exposedSocket,done));
  }
  const requests=[],rawRequests=[];
  http=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);requests.push(body);rawRequests.push(raw);
    if(options.onRequest&&await options.onRequest(body,req,res,pool))return;
    const events=[{type:'message_start',message:{id:'synthetic',model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成质量结果'}},
      {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
    res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  let ledger;
  if(options.problemBudget){
    ledger=join(directory,'problem.sqlite');
    const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
    const env={PATH:process.env.PATH,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname};
    for(const args of [['create','--problem','synthetic-quality','--calls','8','--minutes','30'],['start','--round','r1','--hypothesis','只核验质量case发送处物理累计预算']])
      execFileSync(python,['-m','notalone.experiments.problem_budget','--ledger',ledger,...args],{env,timeout:10000,stdio:'pipe'});
  }
  const home=join(directory,'home'),profile=join(home,'profiles','notalone');await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
  await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(resolve(options.pluginPath??'test/quality-model-plugin.ts'))}\n`);
  async function startProfile(permitSocket){
    child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
    cwd:home,env:{PATH:process.env.PATH,HOME:home,USER:process.env.USER,LOGNAME:process.env.LOGNAME,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',
      NOTALONE_QUALITY_MODEL_CONFIG:JSON.stringify({database,contract}),
      NOTALONE_MODEL_PERMIT_SOCKET:permitSocket,NOTALONE_MODEL_PERMIT_TOKEN:token,
      NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${http.address().port}/anthropic`,
      ...(ledger?{NOTALONE_PROBLEM_BUDGET:ledger,NOTALONE_PROBLEM_ROUND:'r1'}:{})},stdio:['ignore','pipe','pipe']});
  exited=once(child,'exit');let log='';child.stderr.on('data',part=>log+=part);
    return await new Promise((done,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`quality_profile_start_failed:${log.slice(-1000)}`)),12000);
    child.stdout.on('data',part=>{log+=part;const match=log.match(/QUALITY_MODEL_READY (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);done(match[1]);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(`quality_profile_exit:${log.slice(0,1200)}${log.slice(-500)}`));});
  });
  }
  let url=await startProfile(exposedSocket);
  return {pool,store,ownerId,contactId,memoryId,sourceId,ownerMemoryId,requests,rawRequests,transaction,ledger,accounting,
    get permit(){return permit;},get arbiter(){return arbiter;},get url(){return url;},
    settledAfterCorruptAck:()=>settledAfterCorruptAck,
    async restart(){
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;
      await permit.shutdown();arbiter=new ModelPermitArbiter(2);permit=await buildPermit();
      url=await startProfile(socket);
    },
    async case(contact=contactId,{max=16}={}){
      const scope={owner_id:ownerId,contact_id:contact};
      const input=await transaction(client=>store.insertInputInTransaction(client,scope,[{memory_id:contact===null?ownerMemoryId:memoryId,revision:1}]));
      const run=await store.createRun(ownerId,{case_ids:[input.case_id],max_http_attempts:max,dataset_version:'quality-model-synthetic-v1',data_kind:'fixed_synthetic',purpose_confirmed:true});
      const active=await store.claimCase(ownerId,run,options.problemBudget?'sdk':'synthetic',true);
      return {...active,source_ref:qualityInputSourceRef({case_id:active.id,input_sha256:active.input_sha256})};
    },
    async call(active,body={}){
      const response=await fetch(`${url}/call`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({active,...body})});
      const value=await response.json();await permit.refresh?.();return value;
    },
  };
}
