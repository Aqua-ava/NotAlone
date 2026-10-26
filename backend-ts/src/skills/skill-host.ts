/** Skill 普通管理唯一责任方；不承接任意 owner 或模型管理工具。 */
import {HostStorageError,type HostStorage} from '../platform/database/host-storage.ts';
import {SkillLibrary,SkillLibraryError} from './skill-library.ts';
import {SkillFiles} from './skill-files.ts';
import {createReplySkillGuards} from '../reply/generation/reply-skill-guards.ts';
import {createReplyAssistantGuards} from '../reply/generation/reply-assistant-factory.ts';
import {ReplyStoreError} from '../reply/generation/reply-store.ts';
import {deleteSourceReplies} from '../preferences/preference-erasure.ts';
import {eraseManagedUpdateBackups} from '../preferences/preference-files.ts';
export class SkillHost {
 private readonly owner:string|undefined;
 private active=false;
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
 enter(){
  const accepting=()=>this.active;
  if(!this.owner||!accepting()||this.closed)throw new SkillLibraryError('skill_unavailable',503);
  let done!:()=>void;const promise=new Promise<void>(resolve=>{done=resolve;});this.pending.add(promise);
  return {assertCurrent:()=>{if(!accepting()||this.closed)throw new SkillLibraryError('skill_unavailable',503);},finish:()=>{this.pending.delete(promise);done();}};
 }
 /** 官方宿主独占启动后核验原 Skill 文件与业务版本。 */
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
 async close(){this.closed=true;this.active=false;await Promise.all([...this.pending]);}
}
