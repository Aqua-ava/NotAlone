import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {homedir} from 'node:os';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {HostStorage} from '../src/host-storage.ts';
import {SkillLibrary} from '../src/skill-library.ts';
import {SkillFiles} from '../src/skill-files.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startExplorationRuntimeHost,useTool,sendEvents} from './exploration-runtime-support.mjs';

export async function fixture(t,{importSkill=true,onRequest}={}){
 const f=await createStorageFixture();let storage,host,child,exited,output='',closed=false;
 async function close(){
  if(closed)return;closed=true;
  const errors=[],attempt=async action=>{try{await action();}catch(error){errors.push(error);}};
  await attempt(async()=>{if(child){if(child.exitCode===null&&child.signalCode===null)child.stdin.end();const [code]=await exited;assert.equal(code,0,'公开夹具退出异常 '+output);}});
  if(host)await attempt(()=>host.stop());
  if(storage)await attempt(()=>storage.close());
  await attempt(()=>f.client.end());
  await attempt(()=>execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',"import sys,psycopg\nfrom psycopg import sql\nassert sys.argv[1].startswith('notalone_ts_host_') and sys.argv[1].endswith('_test')\nwith psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:c.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(sys.argv[1])))",f.client.database],{timeout:15000,stdio:'pipe'}));
  await attempt(()=>rm(f.directory,{recursive:true}));
  if(errors.length)throw new AggregateError(errors,'公开探索夹具清理失败');
 }
 t.after(close);
 storage=await HostStorage.open(f.options);const {owner_id:owner}=await storage.initializeOwner('合成策略验收本人');
 const contact=randomUUID(),session=randomUUID(),source=randomUUID(),message=randomUUID(),token='synthetic-exploration-skill-service-'.repeat(2),skillsRoot=join(f.directory,'skills');
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(owner_id,contact_id)VALUES($1,$2)',[owner,contact]);await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,owner,contact]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','合成来源',$4,1)",[source,owner,contact,'a'.repeat(64)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text','最近有空吗','2026-01-01T01:02:03.123456Z')",[message,owner,contact]);
 await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,owner,contact,source]);
 const library=new SkillLibrary(storage,new SkillFiles(skillsRoot));let imported,version;
 async function addSkill(name='exploration-purpose'){
  const path=join(f.directory,name);await mkdir(join(path,'references'),{recursive:true});
  await writeFile(join(path,'SKILL.md'),`---\nname: ${name}\ndescription: 合成近况询问目的探索\n---\n\n仅辅助本轮理解，不能确认意愿。EXPLORATION_STATIC_BODY。\n`);
  await writeFile(join(path,'references','hidden.md'),'未获本轮读取权限。EXPLORATION_RESOURCE_FORBIDDEN。');
  const entry=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
  const id=(await f.client.query('SELECT id FROM reply_skill_version WHERE skill_id=$1 AND version_number=$2',[entry.skill_id,entry.version_number])).rows[0].id;
  return {entry,id};
 }
 if(importSkill){const added=await addSkill();imported=added.entry;version=added.id;}
 host=await startExplorationRuntimeHost(t,async(req,res,requests,events)=>{
  const last=requests.at(-1),payload=JSON.parse(last.body.messages[0].content[0].text);const id=payload.evidence[0].evidence_id;
  if(onRequest&&await onRequest({req,res,requests,events,payload,f,library,imported,version,addSkill}))return;
  if(last.body.tools.some(tool=>tool.name==='ExplorationSkillSelection')){assert.equal(payload.skills.length,1);assert.equal(payload.skills[0].version_id,version);useTool(events,'ExplorationSkillSelection',{version_id:version});}
  else{
   assert.deepEqual(last.body.tools.map(x=>x.name),['ExplorationOutput']);
   useTool(events,'ExplorationOutput',{understanding:'对方询问时间，用户尚未明确本次意愿',ambiguities:[],citation_ids:[id],options:[{intent:'了解近况',label:'关心',reason:'当前原话支持近况询问',citation_ids:[id],recommended:true,pause:false},{intent:'稍后联系',label:'稍后',reason:'暂时不便时适用',citation_ids:[],recommended:false,pause:false}],question:null,current_step:'选择本次意愿',tradeoffs:[]});
  }
  sendEvents(res,events);
 },false,{pluginPath:'test/exploration-service-plugin.ts',allowPostgres:true,environment:{NOTALONE_SYNTHETIC_DATABASE:f.client.database,NOTALONE_SYNTHETIC_REPLY_OWNER:owner,NOTALONE_SYNTHETIC_REPLY_TOKEN:token,NOTALONE_SYNTHETIC_SKILLS_ROOT:skillsRoot}});
 child=spawn(homedir()+'/miniconda3/envs/NotAlone/bin/python',['test/exploration-public-fixture.py','--database','host=/tmp dbname='+f.client.database,'--owner',owner,'--remote-url',host.url,'--remote-token',token],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_SKILLS_DIR:skillsRoot},stdio:['pipe','pipe','pipe']});
 child.stderr.on('data',b=>output+=b);exited=once(child,'exit');
 const publicHost=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('公开Skill夹具启动超时 '+output)),15000);child.stdout.on('data',b=>{output+=b;const m=output.match(/READY (.+)\n/);if(m){clearTimeout(timer);resolve(JSON.parse(m[1]));}});child.once('exit',()=>{clearTimeout(timer);reject(Error('公开Skill夹具退出 '+output));});});
 async function send(action,request,extra={}){
  const rbody=structuredClone(request),id=rbody.exploration_id;delete rbody.exploration_id;const cid=extra.contact_id??contact;
  let path=`/api/contacts/${cid}/assistant-sessions/${session}/explorations`;if(action!=='open')path+='/'+id;if(!['open','read'].includes(action))path+='/'+action;
  const r=await fetch(publicHost.url+path,{method:action==='read'?'GET':'POST',headers:{Authorization:`Bearer ${publicHost.token}`,'Content-Type':'application/json',[publicHost.manual_header]:cid},...(action==='read'?{}:{body:JSON.stringify(rbody)})});return {status:r.status,body:await r.json()};
 }
 return {f,storage,library,owner,contact,session,source,message,host,version,imported,addSkill,send,close,publicHost,publicProcess:child};
}
