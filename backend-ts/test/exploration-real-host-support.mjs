/** 正式 launchDsh、原profile与host-plugin、Legacy公开HTTP；没有替代服务插件。 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,symlink,copyFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {launchDsh} from '../src/launch.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {payloadJson} from './exploration-public-support.mjs';
import {sendEvents,useTool} from './reply-service-runtime-support.mjs';
export {sendEvents,useTool};
const root=new URL('../../',import.meta.url).pathname;
const shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
export async function until(check,label,timeout=20000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const value=await check();if(value)return value;await delay(40);}
 throw Error('有界等待失败：'+label);
}
const json=async path=>JSON.parse(await readFile(path,'utf8'));
export async function realHost(t,{onRequest,beforeClose}={}){
 const f=await createStorageFixture();let host,connection,closed=false;
 const business=join(f.directory,'business'),project=join(f.directory,'project'),source=join(project,'backend/src');
 const owner=randomUUID(),contact=randomUUID(),session=randomUUID(),message=randomUUID(),sourceId=randomUUID();
 const infoPath=join(f.directory,'backend.info'),audit=join(f.directory,'private-runtime.json'),fallback=join(f.directory,'python-fallback'),errors=join(f.directory,'host-errors');
 const requests=[],provider=createServer(async(req,res)=>{
  try{
   let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push({path:req.url,headers:req.headers,body});
   const payload=payloadJson(body.messages[0].content[0].text),id=payload.evidence[0].evidence_id;
   const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
   if(onRequest&&await onRequest({body,payload,requests,events,req,res,id}))return;
   if(body.tools.some(tool=>tool.name==='ReplyRuntimeOutput'))useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'最近还好吗？',basis:'只按用户明确选择了解近况',citation_ids:[id],risk_notes:[]}]});
   else useTool(events,'ExplorationOutput',{understanding:'对方询问近况，用户尚未确认意愿',ambiguities:[],citation_ids:[id],options:[{intent:'了解近况',label:'关心',reason:'当前原话支持',citation_ids:[id],recommended:true,pause:false},{intent:'稍后联系',label:'稍后',reason:'由用户决定',citation_ids:[],recommended:false,pause:false}],question:null,current_step:'明确本次意愿',tradeoffs:[]});
   sendEvents(res,events);
  }catch(error){res.writeHead(500).end();t.diagnostic(String(error));}
 });
 async function close(){
  if(closed)return;closed=true;
  const errors=[],attempt=async action=>{try{await action();}catch(error){errors.push(error);}};
  await attempt(()=>beforeClose?.());
  if(connection&&host?.isRunning())await attempt(()=>request('/api/runtime/shutdown',{}));
  if(host)await attempt(()=>host.waitForExit(15000));
  if(host?.isRunning())await attempt(async()=>assert.equal(await host.terminate(),true,'仅异常路径停止自有宿主'));
  if(host)await attempt(()=>assert.equal(host.isRunning(),false));
  await attempt(async()=>{provider.closeAllConnections();if(provider.listening)await new Promise(resolve=>provider.close(resolve));});
  await attempt(()=>until(async()=>(await f.client.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()')).rows[0].n===1,'自有宿主PG排空',6000));
  await attempt(()=>f.close());
  await attempt(()=>rm(f.directory,{recursive:true,force:true}));
  if(errors.length)throw new AggregateError(errors,'正式宿主夹具清理失败');
  t.diagnostic(JSON.stringify({cleanup:{owned_host_exited:true,own_database_dropped_without_force:true,fixture_removed:true,shared_pg_preserved:true}}));
 }
 t.after(close);
 await mkdir(business,{mode:0o700});await mkdir(source,{recursive:true});
 await symlink(join(root,'backend-ts'),join(project,'backend-ts'),'dir');
 await symlink(join(root,'backend/src/notalone'),join(source,'notalone'),'dir');
 await symlink(join(root,'backend/database'),join(project,'backend/database'),'dir');
 await copyFile(new URL('./exploration-real-host-guard.py',import.meta.url),join(source,'sitecustomize.py'));
 await writeFile(errors,'',{mode:0o600});
 const executable=join(f.directory,'synthetic-node');
 await writeFile(executable,`#!/bin/sh\nexec ${shell(process.execPath)} --import ${shell(new URL('./exploration-real-host-guard.mjs',import.meta.url).pathname)} "$@" >>${shell(errors)} 2>&1\n`,{mode:0o700});
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成正式宿主本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成正式联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(owner_id,contact_id)VALUES($1,$2)',[owner,contact]);
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,owner,contact]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','合成来源',$4,1)",[sourceId,owner,contact,'a'.repeat(64)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text','最近有空吗','2026-01-01T01:02:03.123456Z')",[message,owner,contact]);
 await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,owner,contact,sourceId]);
 await writeFile(f.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${f.client.database}\nNOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\nNOTALONE_DEEPSEEK_API_KEY=synthetic-only\nNOTALONE_SKILLS_DIR=${f.directory}/skills\n`,{mode:0o600});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const environment={NOTALONE_MANAGED_USER_DATA:business,NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`,NOTALONE_SYNTHETIC_HOST_ERRORS:errors,NOTALONE_SYNTHETIC_RUNTIME_AUDIT:audit,NOTALONE_SYNTHETIC_FALLBACK_AUDIT:fallback};
 host=await launchDsh({nodeExecutable:executable,projectDirectory:project,envFilePath:f.envFilePath,infoPath,businessHome:business,pythonExecutable:process.env.NOTALONE_TEST_PYTHON??join(homedir(),'miniconda3/envs/NotAlone/bin/python'),environment},()=>true);
 connection=await until(async()=>{
  if(!host.isRunning()){let failure='';try{failure=await readFile(errors,'utf8');}catch{}throw Error('真实宿主提前退出 '+failure);}
  try{return Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));}catch(error){if(error.code!=='ENOENT')throw error;return false;}
 },'正式认证握手');
 async function request(path,body,{token=connection.token,method=body===undefined?'GET':'POST',headers={},manual=contact}={}){
  const response=await fetch(`http://${connection.address}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-NotAlone-Manual-Contact':manual,...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  return {status:response.status,body:await response.json()};
 }
 async function send(action,requestBody,{cid=contact,sid=session,...options}={}){
  const body=structuredClone(requestBody),id=body.exploration_id;delete body.exploration_id;
  let path=`/api/contacts/${cid}/assistant-sessions/${sid}/explorations`;
  if(action!=='open')path+='/'+id;if(!['read','open'].includes(action))path+='/'+action;
  return request(path,action==='read'?undefined:body,{manual:cid,...options});
 }
 const identity=createHash('sha256').update(JSON.stringify([infoPath,f.envFilePath])).digest('hex').slice(0,24);
 const paths={statePath:join(business,'model-permits',identity,'state.json')};
 return {f,owner,contact,session,message,requests,host,provider,connection,request,send,paths,close,
  privateRuntime:()=>json(audit),journal:()=>json(paths.statePath),async assertNoFallback(){assert.equal((await json(audit)).python_model_guard_installed,true);await assert.rejects(stat(fallback),{code:'ENOENT'});}};
}
