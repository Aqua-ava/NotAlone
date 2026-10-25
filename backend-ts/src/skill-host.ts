/** Skill普通管理唯一责任方；私有同步不承接任意owner或模型工具。 */
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {HostStorageError,type HostStorage} from './host-storage.ts';
import type {LegacyBackend} from './legacy-backend.ts';
import {SkillLibrary,SkillLibraryError} from './skill-library.ts';
import {SkillFiles} from './skill-files.ts';
import {createReplySkillGuards} from './reply-skill-guards.ts';
import {createReplyAssistantGuards} from './reply-assistant-factory.ts';
import {ReplyStoreError} from './reply-store.ts';
import {deleteSourceReplies} from './preference-erasure.ts';
import {eraseManagedUpdateBackups} from './preference-files.ts';
import {readWechatHttpBody} from './wechat-http-body.ts';
import {parseJson,stringifyJson} from './host-json.ts';
export class SkillHost {
 private readonly token=randomBytes(32).toString('base64url');
 private readonly owner:string|undefined;
 private active=false;
 private privateSyncReady=false;
 private closed=false;
 private transferring=false;
 private pending=new Set<Promise<void>>();
 readonly library:SkillLibrary;
 readonly requireDiscussionDependencies:(client:Parameters<typeof deleteSourceReplies>[0],owner:string,contact:string,request:string)=>Promise<readonly string[]>;
 constructor(storage:HostStorage,root:string){
  this.owner=storage.runtimeOwnerId?.toLowerCase();
  const files=new SkillFiles(root);
  const requireDiscussionDependencies=async(client:Parameters<typeof deleteSourceReplies>[0],owner:string,contact:string,request:string):Promise<readonly string[]>=>{
   if(owner!==this.owner)throw new ReplyStoreError('reply_context_invalidated');
   // 管理历史按真实回复的绑定校验，不构造新请求或猜当前联系人唯一绑定。
   const savedSkill=createReplySkillGuards({files,requireDiscussionDependencies});
   const {assistant}=createReplyAssistantGuards(savedSkill,async(connection,scope)=>{
    if(scope.owner_id!==owner||scope.contact_id!==contact)throw new ReplyStoreError('reply_context_invalidated');
    const row=(await connection.query("SELECT request.conversation_binding_id AS id FROM reply_request request WHERE request.id=$1 AND request.owner_id=$2 AND request.contact_id=$3 AND (EXISTS(SELECT 1 FROM conversation_binding b WHERE b.id=request.conversation_binding_id AND b.owner_id=request.owner_id AND b.contact_id=request.contact_id AND b.status='active') OR EXISTS(SELECT 1 FROM manual_contact_confirmation m WHERE m.id=request.conversation_binding_id AND m.owner_id=request.owner_id AND m.contact_id=request.contact_id))",[request,owner,contact])).rows[0];
    if(!row)throw new ReplyStoreError('reply_context_invalidated');return row.id;
   });
   const ids=await assistant.requireReplyDiscussionById(client,{owner_id:owner,contact_id:contact},request);
   if(ids===null)throw new ReplyStoreError('reply_context_invalidated');return ids;
  };
  this.requireDiscussionDependencies=requireDiscussionDependencies;
  this.library=new SkillLibrary(storage,files,{requireDiscussionDependencies,
   eraseManagedBackups:async client=>{
    try{await eraseManagedUpdateBackups(client,storage.runtimeEnvironment());}
    catch(error){if(error instanceof HostStorageError&&error.code==='update_backup_cleanup_required')throw new SkillLibraryError(error.code,409);throw error;}
   },
   deleteSourceReplies:(client,input)=>deleteSourceReplies(client,input.ownerId,input.removedIds,input.contactId,input.revokeRunningScope)});
 }
 status(){return {owner:this.active?'typescript':'unavailable',state:this.closed?'stopped':this.active?'running':this.transferring?'transferring':'unavailable',active_requests:this.pending.size};}
 enter(privateSync=false){
  const accepting=()=>privateSync?this.privateSyncReady:this.active;
  if(!this.owner||!accepting()||this.closed)throw new SkillLibraryError('skill_unavailable',503);
  let done!:()=>void;const promise=new Promise<void>(resolve=>{done=resolve;});this.pending.add(promise);
  return {assertCurrent:()=>{if(!accepting()||this.closed)throw new SkillLibraryError('skill_unavailable',503);},finish:()=>{this.pending.delete(promise);done();}};
 }
 async transfer(legacy:Pick<LegacyBackend,'control'>,port:number){
  if(this.closed||this.transferring||this.active)throw new SkillLibraryError('skill_unavailable',503);
  if(!this.owner)return;
  this.transferring=true;
  try{
   const stopped=await legacy.control('/api/runtime/skill-management/stop','POST',{});
   if(!['stopped','draining'].includes(String(stopped.state)))throw new SkillLibraryError('skill_handoff_failed',503);
   for(let i=0;;i++){
    if(this.closed)throw new SkillLibraryError('skill_unavailable',503);
    const status=await legacy.control('/api/runtime/skill-management/status','GET');
    if(status.state==='stopped'&&status.active_requests===0)break;
    if(i===100)throw new SkillLibraryError('skill_drain_timeout',503);await delay(25);
   }
   // Python安装remote后即可并发同步；公开管理仍须等待activate完整ACK。
   this.privateSyncReady=true;
   const result=await legacy.control('/api/runtime/skill-management/activate','POST',{owner_id:this.owner,port,token:this.token});
   if(this.closed||result.state!=='remote'||result.active_requests!==0)throw new SkillLibraryError('skill_handoff_failed',503);
   this.active=true;
  }finally{this.transferring=false;if(!this.active)this.privateSyncReady=false;}
 }
 /** 官方宿主已独占启动且没有兼容进程时，直接核验原 Skill 文件与业务版本。 */
 async activateStandalone(){
  if(this.closed||this.transferring||this.active)throw new SkillLibraryError('skill_unavailable',503);
  if(!this.owner)return;
  this.transferring=true;
  try{
   await this.library.synchronize(this.owner,()=>{if(this.closed)throw new SkillLibraryError('skill_unavailable',503);});
   if(this.closed)throw new SkillLibraryError('skill_unavailable',503);
   this.active=true;
  }finally{this.transferring=false;}
 }
 async privateHttp(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const path=new URL(req.url??'','http://localhost').pathname;
  if(!path.startsWith('/api/runtime/skill-management/'))return false;
  const respond=(status:number,value:unknown)=>{const body=stringifyJson(value);res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body)});res.end(body);};
  const given=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${this.token}`);
  if(given.length!==expected.length||!timingSafeEqual(given,expected)||req.headers.origin!==undefined){respond(401,{error:'unauthorized'});return true;}
  if(req.url!=='/api/runtime/skill-management/synchronize'||req.method!=='POST'){respond(400,{error:'skill_request_invalid'});return true;}
  let lease:ReturnType<SkillHost['enter']>|undefined;
  try{
   lease=this.enter(true);const body=parseJson((await readWechatHttpBody(req,1024)).toString('utf8')) as Record<string,unknown>;
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='owner_id'||body.owner_id!==this.owner)throw new SkillLibraryError('skill_request_invalid',400);
   const revision=await this.library.synchronize(this.owner!,()=>{lease!.assertCurrent();if(req.aborted||res.destroyed)throw new SkillLibraryError('skill_unavailable',503);});
   respond(200,{revision});
  }catch(error){respond(error instanceof SkillLibraryError?error.status:400,{error:error instanceof SkillLibraryError?error.code:'skill_request_invalid'});}
  finally{lease?.finish();}return true;
 }
 async close(){this.closed=true;this.active=false;this.privateSyncReady=false;await Promise.all([...this.pending]);}
}
