/** 官方持久化适配层；目录身份及业务提交资格由讨论服务在调用前后核验。 */
import {randomUUID} from 'node:crypto';
import {sha256} from '../../platform/sha256.ts';
import {lstat,realpath,readdir,open} from 'node:fs/promises';
import {constants,type BigIntStats} from 'node:fs';
import path from 'node:path';
import type {Context,Fiber} from '@deepseek-ai/cordis';
import {Group,type Loader} from '@deepseek-ai/cordis-plugin-loader';
import type {AgentHandle,CreateAgentOptions,ResumeAgentOptions} from '@deepseek-ai/dsh-agent';
import {SESSION_FORMAT_VERSION,type SessionEvent,type SessionId} from '@deepseek-ai/dsh-session';
import type {SessionHandle} from '@deepseek-ai/dsh-session-persistence';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {SkillDirectory,skillWorkingDirectory} from './skill-directory.ts';

export interface DshEventBoundary {
 formatVersion:number;eventCount:number;lastSeq:number|null;eventSha256:string;
}
export interface DshHistory {boundary:DshEventBoundary;events:readonly SessionEvent[]}
export interface DshRuntimeDriver {
 createAgent(options:CreateAgentOptions):Promise<AgentHandle>;
 resumeAgent(options:ResumeAgentOptions):Promise<AgentHandle>;
 /** 必须在Agent释放后调用；以官方独占writer核验真实持久边界。 */
 readHistory(id:SessionId):Promise<DshHistory>;
 close():Promise<void>;
}
const failure=()=>new StorageFailure('discussion_runtime_unavailable');
function boundary(events:readonly SessionEvent[]):DshEventBoundary {
 return {formatVersion:SESSION_FORMAT_VERSION,eventCount:events.length,lastSeq:events.at(-1)?.seq??null,
  eventSha256:sha256(JSON.stringify(events))};
}

/** 只接受受信任宿主已排他创建、登记真实身份的私有副本根；本层不创建或接管根。 */
export async function createDshRuntime(parent:Context,options:{root:string}):Promise<DshRuntimeDriver>{
 const {root}=options;let rootIdentity:BigIntStats;
 try {
  const status=await lstat(root,{bigint:true});rootIdentity=status;
  if(!path.isAbsolute(root)||await realpath(root)!==root||!status.isDirectory()||status.isSymbolicLink()
   ||status.uid!==BigInt(process.getuid!())||(status.mode&0o077n)!==0n)throw failure();
 }catch{throw failure();}
 const same=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs&&a.uid===b.uid;
 async function tighten(location=root,ancestors:{location:string;identity:BigIntStats}[]=[]):Promise<void>{
  if(!same(await lstat(root,{bigint:true}),rootIdentity!))throw failure();
  for(const ancestor of ancestors)if(!same(await lstat(ancestor.location,{bigint:true}),ancestor.identity))throw failure();
  const info=await lstat(location,{bigint:true});
  if(info.isSymbolicLink()||(!info.isFile()&&!info.isDirectory())||info.uid!==rootIdentity!.uid
   ||(info.isFile()&&info.nlink!==1n))throw failure();
  const fd=await open(location,constants.O_RDONLY|constants.O_NOFOLLOW|(info.isDirectory()?constants.O_DIRECTORY:0));
  try{
   if(!same(await fd.stat({bigint:true}),info))throw failure();
   await fd.chmod(info.isDirectory()?0o700:0o600);
   if(info.isDirectory())for(const name of await readdir(location))await tighten(path.join(location,name),[...ancestors,{location,identity:info}]);
  }finally{await fd.close();}
 }
 const loader=parent.get('loader') as Loader|undefined;
 if(!loader)throw failure();
 const plugins:Fiber[]=[],handles=new Set<SessionHandle>(),agents=new Set<AgentHandle>(),operations=new Set<Promise<unknown>>();
 const deps=['sessions','agents','sessionProjections','sessionPersistence','systemPrompt','tools','skills','workingDirectory'];
 const isolated=[...deps,'agentLoop','fs'];
 const builtin='notalone-discussion-'+randomUUID(),consumerBuiltin=builtin+'-consumer';
 let groupId:string|undefined,groupFiber:Fiber|undefined,consumer:Context|undefined,agentContext:Context|undefined,sdkFailed=false;
 // Cordis会把部分scope释放错误转为日志；只看本域的级别和fiber，不读或保存正文参数。
 const removeExporter=parent.logger.exporter({export(message){
  if(message.type!=='error'&&message.type!=='warn')return;
  let fiber=message.fiber?.deref();
  while(fiber){
   if(fiber===groupFiber){sdkFailed=true;return;}
   const ancestor=fiber.parent.fiber;if(ancestor===fiber)break;fiber=ancestor;
  }
 }});
 let loop:Promise<void>|undefined,closing:Promise<void>|undefined,stopping=false;
 loader.builtins[builtin]=Group;
 loader.builtins[builtin+'-directory']=SkillDirectory;
 loader.builtins[consumerBuiltin]={name:'notalone-sqlite-discussion-runtime',inject:deps,apply(current:Context){consumer=current;}};
 async function mount(name:string,config?:unknown,inject?:string[]){
  const id=await loader!.create({name,config,inject},groupId);
  const fiber=loader!.resolve(id).fiber;if(!fiber)throw failure();
  plugins.push(fiber);await fiber.await();return fiber.ctx;
 }
 async function unload(){
  const errors:unknown[]=[];
  for(const fiber of [...plugins].reverse())try{await fiber.dispose();}catch(error){errors.push(error);}
  if(groupId){
   const group=loader!.resolve(groupId);
   try{await group.fiber?.dispose();}catch(error){errors.push(error);}
   loader!.remove(groupId);
  }
  delete loader!.builtins[consumerBuiltin];delete loader!.builtins[builtin];delete loader!.builtins[builtin+'-directory'];
  await removeExporter();
  if(errors.length||sdkFailed)throw failure();
 }
 try{
  // 仅使用官方Loader的group/isolate/entry.inject；后代scope注入由Loader负责。
  groupId=await loader.create({name:'cordis:'+builtin,group:true,
   isolate:Object.fromEntries(isolated.map(name=>[name,true])),config:[]});
  const group=loader.resolve(groupId);if(!group.fiber)throw failure();groupFiber=group.fiber;await group.fiber.await();
  await mount(import.meta.resolve('@deepseek-ai/dsh-session'));
  await mount(import.meta.resolve('@deepseek-ai/dsh-agent'));
  await mount(import.meta.resolve('@deepseek-ai/dsh-session-projection'));
  await mount(import.meta.resolve('@deepseek-ai/dsh-system-prompt'),{includeHarnessIdentity:false,includeRuntimeContext:false});
  await mount(import.meta.resolve('@deepseek-ai/dsh-tools'),{mode:'native'});
  await mount(import.meta.resolve('@deepseek-ai/dsh-skill'));
  await mount('cordis:'+builtin+'-directory');
  await mount(import.meta.resolve('@deepseek-ai/dsh-working-directory'),{defaultDirectory:skillWorkingDirectory});
  await mount(import.meta.resolve('@deepseek-ai/dsh-tool-skill'));
  await mount(import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'),{root,compression:'none'});
  await mount('cordis:'+consumerBuiltin);
  if(!consumer)throw failure();
 }catch{await unload().catch(()=>{});throw failure();}
 const current=consumer;
 const run=<T>(work:()=>Promise<T>):Promise<T>=>{
  if(stopping)return Promise.reject(failure());
  const pending=Promise.resolve().then(async()=>{
   if(!same(await lstat(root,{bigint:true}),rootIdentity!))throw failure();
   const result=await work();if(sdkFailed)throw failure();return result;
  }).catch(()=>{throw failure();});operations.add(pending);
  pending.then(()=>operations.delete(pending),()=>operations.delete(pending));return pending;
 };
 async function releaseHandle(handle:SessionHandle){await handle.close();handles.delete(handle);}
 async function readyLoop(){
  if(!parent.get('llm'))throw failure();
  loop??=(async()=>{agentContext=await mount(import.meta.resolve('@deepseek-ai/dsh-agent-loop'),{agents:[]},[...deps,'llm']);})();await loop;
 }
 async function ownAgent(create:()=>Promise<AgentHandle>):Promise<AgentHandle>{
  await readyLoop();const owned=await create();let disposing:Promise<void>|undefined;
  const handle:AgentHandle={agent:owned.agent,dispose(){
   return disposing??=owned.dispose().then(()=>{if(sdkFailed)throw failure();agents.delete(handle);});
  }};agents.add(handle);return handle;
 }
 return {
  createAgent:options=>run(()=>ownAgent(()=>agentContext!.agents.create(options))),
  resumeAgent:options=>run(()=>ownAgent(()=>agentContext!.agents.resume(options))),
  readHistory:id=>run(async()=>{
   const writer=await current.sessionPersistence.open(id,'write');handles.add(writer);
   try{await writer.flush();const events=(await writer.read()).events;return {events,boundary:boundary(events)};}
   finally{await releaseHandle(writer);}
  }),
  close(){
   stopping=true;
   return closing??=(async()=>{
    // 开始创建的操作也须结算；cancel或调用方超时不证明SDK已停止末写。
    await Promise.allSettled([...operations]);const failures:unknown[]=[];
    for(const handle of [...agents])try{await handle.dispose();}catch(error){failures.push(error);}
    for(const handle of [...handles])try{await releaseHandle(handle);}catch(error){failures.push(error);}
    try{await unload();}catch(error){failures.push(error);}
    if(failures.length)throw failure();
    // 官方session.lock可能使用0644；排空后仅收紧已核验的本副本，不改全局umask。
    try{await tighten();}catch{throw failure();}
   })();
  },
 };
}
