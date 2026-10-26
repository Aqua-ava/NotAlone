import type {AssistantRuntime} from '../reply/runtime/assistant-runtime.ts';
import {captureAssistantRuntimeScope,withAssistantRuntimeErasure} from '../reply/runtime/assistant-runtime-erasure.ts';
/** 跨域删除的管理入口；确定性业务模块拥有事务、租约和完成判定。 */
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,rmdirSync,unlinkSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type pg from 'pg';
import {HostStorageError,type HostStorage} from '../platform/database/host-storage.ts';
import {parseJson,stringifyJson} from '../host/host-json.ts';
import {deleteSourceReplies} from '../preferences/preference-erasure.ts';
import {eraseMemoryDependencies} from '../memory/records/mutations/erasure.ts';
import {eraseSourceTraces} from '../memory/records/mutations/erasure.ts';
import {eraseContactPreferences,eraseSourcePreferences} from '../preferences/preference-service.ts';
import {AssistantDiscussionError,AssistantDiscussionService,requireAssistantSessionAliasSettled} from '../reply/discussion/assistant-discussion-service.ts';
import {eraseManagedUpdateBackups} from '../preferences/preference-files.ts';
import {queueUnreferencedPreferenceFiles} from '../preferences/preference-files.ts';
import {SkillFiles} from '../skills/skill-files.ts';
import {cleanupSkillFiles,queueSkillFileCleanup} from '../skills/skill-cleanup.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses=new Set(['queued','running','verifying','succeeded','failed']);
const phases=new Set(['invalidate','erase','file_cleanup','verify','complete']);
type SourceKind='source_document'|'local_wechat_observation';
type Row=Record<string,any>;

export class CrossDomainDeletionError extends HostStorageError {
  readonly status:number;
  constructor(code:string,status=409){super(code);this.name='CrossDomainDeletionError';this.status=status;}
}
export interface CrossDomainDeletionResponse {status:number;body:Row}

export function crossDomainDeletionRoute(method:string,pathname:string):boolean {
  return method==='DELETE'&&(/^\/api\/contacts\/[^/]+\/sources\/[^/]+$/.test(pathname)
      ||/^\/api\/contacts\/[^/]+\/assistant-sessions\/[^/]+$/.test(pathname)
      ||/^\/api\/contacts\/[^/]+$/.test(pathname)||pathname==='/api/account')
    ||method==='GET'&&(/^\/api\/deletions$/.test(pathname)||/^\/api\/deletions\/[^/]+$/.test(pathname))
    ||method==='POST'&&/^\/api\/deletions\/[^/]+\/retry$/.test(pathname);
}

/** 仅供认证后的产品宿主调用；空正文只允许现有来源/讨论的既有确认入口。 */
export async function serveCrossDomainDeletion(
  req:IncomingMessage,res:ServerResponse,service:CrossDomainDeletionService|undefined,
):Promise<void>{
  const respond=(status:number,body:Row)=>{
    const encoded=stringifyJson(body);
    res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':Buffer.byteLength(encoded)});
    res.end(encoded);
  };
  if(!service){respond(503,{error:'deletion_unavailable'});return;}
  try{
    const url=new URL(req.url??'','http://localhost');
    let body:unknown={};
    if(req.method==='DELETE'||req.method==='POST'){
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){
        const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=value.length;
        if(size>16384){respond(400,{error:'deletion_request_invalid'});return;}
        chunks.push(value);
      }
      const text=Buffer.concat(chunks).toString('utf8');
      if(text.trim())body=parseJson(text);
    }
    const result=await service.handle(req.method??'',url,body);
    respond(result.status,result.body);
  }catch(error){
    if(res.headersSent)return;
    const value=error instanceof CrossDomainDeletionError
      ?error:error instanceof SyntaxError
        ?new CrossDomainDeletionError('deletion_request_invalid',400)
        :new CrossDomainDeletionError('deletion_unavailable',503);
    respond(value.status,{error:value.code});
  }
}

function id(value:string):string {
  if(!uuid.test(value))throw new CrossDomainDeletionError('deletion_request_invalid',400);
  return value.toLowerCase();
}
function digest(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function scopeKey(owner:string,subject:readonly unknown[]):string{return digest([owner,...subject]);}

/** 来源、联系人、账户和讨论删除共用同一持久操作、租约和完成判定。 */
export class CrossDomainDeletionService {
  private readonly runtime?:AssistantRuntime;
  private readonly storage:HostStorage;
  private readonly owner:string;
  private readonly skillsRoot:string;
  private readonly discussions:AssistantDiscussionService;
  private readonly files:SkillFiles;
  constructor(options:{storage:HostStorage;skillsRoot:string;assistantRuntime?:AssistantRuntime}){
    if(!options?.skillsRoot?.trim())throw new Error('deletion_skills_root_required');
    this.runtime=options.assistantRuntime;this.storage=options.storage;this.skillsRoot=options.skillsRoot;this.files=new SkillFiles(this.skillsRoot);
    const owner=this.storage.runtimeOwnerId?.toLowerCase();
    if(!owner)throw new CrossDomainDeletionError('deletion_unavailable',503);
    this.owner=owner;
    this.discussions=new AssistantDiscussionService({transaction:work=>this.storage.businessTransaction(work),
      skillsRoot:this.skillsRoot,environment:this.storage.runtimeEnvironment()});
  }

  async handle(method:string,url:URL,body?:unknown):Promise<CrossDomainDeletionResponse>{
    const owner=this.owner;
    if(method==='DELETE'){
      const source=/^\/api\/contacts\/([^/]+)\/sources\/([^/]+)$/.exec(url.pathname);
      if(source&&!url.search){return this.deleteSource(owner,id(source[1]),id(source[2]));}
      if(source)throw new CrossDomainDeletionError('deletion_request_invalid',400);
      const discussion=/^\/api\/contacts\/([^/]+)\/assistant-sessions\/([^/]+)$/.exec(url.pathname);
      if(discussion&&!url.search)return this.deleteDiscussion(owner,id(discussion[1]),id(discussion[2]),body);
      if(discussion)throw new CrossDomainDeletionError('deletion_request_invalid',400);
      const contact=/^\/api\/contacts\/([^/]+)$/.exec(url.pathname);
      if(contact&&!url.search)return this.deleteContact(owner,id(contact[1]),body);
      if(contact)throw new CrossDomainDeletionError('deletion_request_invalid',400);
      if(url.pathname==='/api/account'&&!url.search)return this.deleteAccount(owner,body);
    }
    if(method==='GET'&&url.pathname==='/api/deletions'){
      if(!url.search)return this.list(owner);
      if([...url.searchParams.keys()].sort().join(',')!=='contact_id,scope_kind'||url.searchParams.get('scope_kind')!=='discussion')throw new CrossDomainDeletionError('deletion_request_invalid',400);
      return this.list(owner,id(url.searchParams.get('contact_id')??''));
    }
    const retry=/^\/api\/deletions\/([^/]+)\/retry$/.exec(url.pathname);
    if(method==='POST'&&retry&&!url.search){
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||(body as Row).confirmed!==true){
        throw new CrossDomainDeletionError('deletion_confirmation_required',400);
      }
      return this.retry(owner,id(retry[1]));
    }
    if(method==='GET'){
      const match=/^\/api\/deletions\/([^/]+)$/.exec(url.pathname);
      if(match&&!url.search)return this.read(owner,id(match[1]));
    }
    throw new CrossDomainDeletionError('not_found',404);
  }

  private async deleteSource(owner:string,contact:string,source:string):Promise<CrossDomainDeletionResponse>{
    const subjects:Record<SourceKind,string>={
      source_document:scopeKey(owner,['source','source_document',contact,source]),
      local_wechat_observation:scopeKey(owner,['source','local_wechat_observation',contact,source]),
    };
    const operation=await this.storage.businessTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${owner}:${contact}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      const existing=(await client.query('SELECT * FROM public.cross_domain_deletion_operation WHERE subject_sha256=ANY($1::text[]) FOR UPDATE',
        [[subjects.source_document,subjects.local_wechat_observation]])).rows[0];
      if(existing)return existing;
      const found=(await client.query(`SELECT source.id,source.status,source.record_count
        FROM public.source_document source
        WHERE source.owner_id=$1 AND source.contact_id=$2 AND source.id=$3 FOR UPDATE`,[owner,contact,source])).rows[0];
      const observation=(await client.query(`SELECT observation.id,observation.record_count
        FROM public.local_wechat_observation observation
        WHERE observation.owner_id=$1 AND observation.contact_id=$2 AND observation.id=$3 FOR UPDATE`,
      [owner,contact,source])).rows[0];
      if(found&&observation)throw new CrossDomainDeletionError('source_kind_ambiguous',409);
      if(!found&&!observation)throw new CrossDomainDeletionError('source_not_found',404);
      const sourceKind:SourceKind=found?'source_document':'local_wechat_observation';
      const recordCount=found?.record_count??observation?.record_count;
      if(found?.status==='deleted'){
        throw new CrossDomainDeletionError('legacy_deletion_unverified',409);
      }
      const operation=randomUUID();
      await client.query(`INSERT INTO public.cross_domain_deletion_operation
        (id,subject_sha256,scope_kind,source_kind,owner_id,contact_id,target_id)
        VALUES($1,$2,'source',$3,$4,$5,$6)`,[operation,subjects[sourceKind],sourceKind,owner,contact,source]);
      if(sourceKind==='source_document'){
        await client.query(`INSERT INTO public.background_task
          (id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,started_at)
          VALUES($1,$2,$3,$4,'delete','running','delete_derived',$5,now())`,[operation,owner,contact,source,recordCount]);
        await client.query(`INSERT INTO public.background_task_step(task_id,step_name,step_order,status,started_at,finished_at)
          VALUES($1,'mark_deleted',1,'succeeded',now(),now()),
                ($1,'delete_derived',2,'running',now(),NULL),
                ($1,'delete_index',3,'pending',NULL,NULL),
                ($1,'clear_cache',4,'pending',NULL,NULL),
                ($1,'verify_not_retrievable',5,'pending',NULL,NULL)`,[operation]);
        await client.query(`UPDATE public.source_document SET status='delete_requested',deletion_operation_id=$4,deletion_error_code=NULL
          WHERE owner_id=$1 AND contact_id=$2 AND id=$3`,[owner,contact,source,operation]);
      }
      return {id:operation,scope_kind:'source',owner_id:owner,contact_id:contact,target_id:source,status:'queued',phase:'invalidate'} as Row;
    });
    await this.executeSource(operation);
    return {status:202,body:{task_id:operation.id}};
  }

  private async deleteDiscussion(owner:string,contact:string,session:string,body:unknown):Promise<CrossDomainDeletionResponse>{
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||(body as Row).confirmed!==true){
      throw new CrossDomainDeletionError('deletion_confirmation_required',400);
    }
    const subject=scopeKey(owner,['discussion',contact,session]);
    const operation=await this.storage.businessTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${owner}:${contact}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      try{await requireAssistantSessionAliasSettled(client,{owner_id:owner,contact_id:contact},session);}catch(error){if(error instanceof AssistantDiscussionError)throw new CrossDomainDeletionError('assistant_session_in_progress',409);throw error;}
      const existing=(await client.query('SELECT * FROM public.cross_domain_deletion_operation WHERE subject_sha256=$1 FOR UPDATE',[subject])).rows[0];
      if(existing)return existing;
      if(!(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2 FOR UPDATE',[owner,contact])).rowCount)
        throw new CrossDomainDeletionError('contact_not_found',404);
      const created=randomUUID();
      await client.query(`INSERT INTO public.cross_domain_deletion_operation
        (id,subject_sha256,scope_kind,owner_id,contact_id,target_id)
        VALUES($1,$2,'discussion',$3,$4,$5)`,[created,subject,owner,contact,session]);
      await captureAssistantRuntimeScope(client,created,owner,contact,session);
      return {id:created,scope_kind:'discussion',owner_id:owner,contact_id:contact,target_id:session,status:'queued',phase:'invalidate'} as Row;
    });
    if(operation.status==='succeeded')return {status:200,body:{session_id:session,state:'deleted',operation_id:operation.id}};
    // 执行失败仍返回原操作身份；调用方必须读取完成状态，不能用业务404替代清盘回执。
    await this.executeDiscussion(operation).catch(()=>{});
    const current=await this.read(owner,operation.id);
    return current.body.status==='succeeded'
      ?{status:200,body:{session_id:session,state:'deleted',operation_id:operation.id}}
      :{status:202,body:{operation_id:operation.id,state:'accepted'}};
  }

  private executeDiscussion(operation:Row):Promise<void>{return withAssistantRuntimeErasure(operation.id,()=>this.eraseDiscussion(operation));}

  private async eraseDiscussion(operation:Row):Promise<void>{
    const claimed=await this.claim(operation.id);
    if(!claimed)return;
    try{
      await this.runtime?.drain(claimed.id);
      await this.discussions.deleteSession({owner_id:claimed.owner_id,contact_id:claimed.contact_id},claimed.target_id);
      await this.cleanupRuntime(claimed);
      await this.cleanupFiles(claimed.owner_id);
      await this.complete(claimed,'discussion');
    }catch(error){
      await this.fail(claimed,error).catch(()=>{});
      if(error instanceof AssistantDiscussionError)throw new CrossDomainDeletionError(error.code,error.status);
      if(error instanceof HostStorageError)throw error;
      throw new CrossDomainDeletionError('discussion_deletion_failed',503);
    }
  }

  private executeSource(operation:Row):Promise<void>{return withAssistantRuntimeErasure(operation.id,()=>this.eraseSource(operation));}

  private async eraseSource(operation:Row):Promise<void>{
    const claimed=await this.claim(operation.id);
    if(!claimed)return;
    try{
      await this.runtime?.drain(claimed.id);
      await this.storage.businessTransaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${claimed.owner_id}:${claimed.contact_id}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${claimed.owner_id}`]);
        await this.assertLease(client,claimed);
        const sourceKind=claimed.source_kind as SourceKind;
        if(sourceKind!=='source_document'&&sourceKind!=='local_wechat_observation')
          throw new CrossDomainDeletionError('deletion_result_invalid',500);
        const source=(await client.query(`SELECT 1 FROM public.${sourceKind==='source_document'?'source_document':'local_wechat_observation'}
          WHERE owner_id=$1 AND contact_id=$2 AND id=$3 FOR UPDATE`,[claimed.owner_id,claimed.contact_id,claimed.target_id])).rows[0];
        if(!source&&sourceKind==='source_document')throw new CrossDomainDeletionError('source_not_found',404);
        if(source&&sourceKind==='source_document')
          await client.query("UPDATE public.source_document SET status='deleting' WHERE owner_id=$1 AND contact_id=$2 AND id=$3",
            [claimed.owner_id,claimed.contact_id,claimed.target_id]);
        await eraseManagedUpdateBackups(client,this.storage.runtimeEnvironment());
        if(sourceKind==='source_document')await eraseManagedMedia(client,claimed.owner_id,claimed.contact_id,claimed.target_id);
        await eraseSourceClosure(client,claimed.owner_id,claimed.contact_id,sourceKind,claimed.target_id);
        if(sourceKind==='source_document'){
          await client.query("UPDATE public.background_task_step SET status='succeeded',finished_at=now() WHERE task_id=$1 AND step_name IN ('delete_derived','delete_index','clear_cache')",[claimed.id]);
          await client.query("UPDATE public.background_task_step SET status='running',started_at=now() WHERE task_id=$1 AND step_name='verify_not_retrievable'",[claimed.id]);
          await client.query("UPDATE public.background_task SET current_step='verify_not_retrievable',status='verifying',updated_at=now() WHERE id=$1",[claimed.id]);
        }
        await client.query("UPDATE public.cross_domain_deletion_operation SET phase='verify',updated_at=now() WHERE id=$1",[claimed.id]);
      });
      await this.cleanupRuntime(claimed);
      await this.cleanupFiles(claimed.owner_id);
      await this.storage.businessTransaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${claimed.owner_id}:${claimed.contact_id}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${claimed.owner_id}`]);
        await this.assertLease(client,claimed);
        const sourceKind=claimed.source_kind as SourceKind;
        const sourceColumn=sourceKind==='source_document'?'source_document_id':'observation_id';
        const remaining=(await client.query(`SELECT
          (SELECT count(*) FROM public.message_source_ref WHERE owner_id=$1 AND contact_id=$2 AND ${sourceColumn}=$3)
          +(SELECT count(*) FROM public.import_confirmation WHERE owner_id=$1 AND contact_id=$2 AND source_document_id=$3)
          +(SELECT count(*) FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND source_ids&&ARRAY[$3::uuid])
          +(SELECT count(*) FROM public.memory_candidate WHERE owner_id=$1 AND contact_id=$2 AND source_ids&&ARRAY[$3::uuid])
          +(SELECT count(*) FROM public.owner_memory WHERE owner_id=$1 AND source_ids&&ARRAY[$3::uuid])
          +(SELECT count(*) FROM public.expression_preference WHERE owner_id=$1 AND source_ids&&ARRAY[$3::uuid])
          +(SELECT count(*) FROM public.memory_correction_decision WHERE owner_id=$1 AND contact_id=$2
              AND (evidence->'source_ids') ? $3::text)
          +(SELECT count(*) FROM public.source_processing_record record JOIN public.source_processing_batch batch
              ON batch.batch_id=record.batch_id AND batch.owner_id=record.owner_id AND batch.contact_id=record.contact_id
            WHERE batch.owner_id=$1 AND batch.contact_id=$2 AND batch.source_kind=$4
              AND batch.source_id=$3 AND record.payload IS NOT NULL)
          +(SELECT count(*) FROM public.memory_extraction_trace_dependency WHERE owner_id=$1 AND source_id=$3)
          +(SELECT count(*) FROM public.layered_memory_batch
            WHERE owner_id=$1 AND contact_id=$2 AND dependency_ids&&ARRAY[$3::uuid])
          +(SELECT count(*) FROM public.layered_memory_feedback
            WHERE owner_id=$1 AND contact_id=$2 AND dependency_ids&&ARRAY[$3::uuid])
          +(SELECT count(*) FROM public.layered_profile_batch
            WHERE owner_id=$1 AND contact_id=$2 AND dependency_ids&&ARRAY[$3::uuid])
          AS count`,[claimed.owner_id,claimed.contact_id,claimed.target_id,sourceKind])).rows[0].count;
        if(Number(remaining)!==0)throw new CrossDomainDeletionError('deletion_verification_failed',409);
        const completed=sourceKind==='source_document'
          ?(await client.query(`UPDATE public.source_document
            SET status='deleted',file_name=NULL,content_sha256=NULL,record_count=0,deleted_at=now(),deletion_operation_id=NULL,deletion_error_code=NULL
            WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='deleting' RETURNING id`,
          [claimed.owner_id,claimed.contact_id,claimed.target_id])).rowCount
          :(await client.query(`DELETE FROM public.local_wechat_observation
            WHERE owner_id=$1 AND contact_id=$2 AND id=$3 RETURNING id`,
          [claimed.owner_id,claimed.contact_id,claimed.target_id])).rowCount;
        if(completed!==1)throw new CrossDomainDeletionError('deletion_verification_failed',409);
        if(sourceKind==='source_document'){
          await client.query("UPDATE public.background_task_step SET status='succeeded',finished_at=now() WHERE task_id=$1",[claimed.id]);
          await client.query("UPDATE public.background_task SET status='succeeded',current_step='verify_not_retrievable',finished_at=now(),updated_at=now() WHERE id=$1",[claimed.id]);
        }
        await this.finishRuntimeTargets(client,claimed.id);
        const succeeded=(await client.query(`UPDATE public.cross_domain_deletion_operation
          SET status='succeeded',phase='complete',source_kind=NULL,owner_id=NULL,contact_id=NULL,target_id=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now()
          WHERE id=$1 AND status='running' AND lease_generation=$2`,[claimed.id,claimed.lease_generation])).rowCount;
        if(succeeded!==1)throw new CrossDomainDeletionError('deletion_lease_lost',409);
      });
    }catch(error){
      const code=error instanceof HostStorageError?error.code:'deletion_execution_failed';
      await this.failSource(claimed,code).catch(()=>{});
    }
  }

  private async deleteContact(owner:string,contact:string,body:unknown):Promise<CrossDomainDeletionResponse>{
    if(!body||typeof body!=='object'||Array.isArray(body)
      ||Object.keys(body).sort().join(',')!=='confirm_contact_id,confirmed'
      ||(body as Row).confirmed!==true||(body as Row).confirm_contact_id!==contact){
      throw new CrossDomainDeletionError('deletion_confirmation_required',400);
    }
    const subject=scopeKey(owner,['contact',contact]);
    const operation=await this.storage.businessTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${owner}:${contact}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      const existing=(await client.query('SELECT * FROM public.cross_domain_deletion_operation WHERE subject_sha256=$1 FOR UPDATE',[subject])).rows[0];
      if(existing)return existing;
      const present=(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2 FOR UPDATE',[owner,contact])).rowCount!==0;
      if(!present){
        const residual=(await client.query(`SELECT
          EXISTS(SELECT 1 FROM public.media_attempt WHERE owner_id=$1 AND contact_id=$2)
          OR EXISTS(SELECT 1 FROM public.media_request_tombstone WHERE owner_id=$1 AND contact_id=$2)
          AS exists`,[owner,contact])).rows[0].exists;
        if(!residual)throw new CrossDomainDeletionError('contact_not_found',404);
      }
      const operation=randomUUID();
      await client.query(`INSERT INTO public.cross_domain_deletion_operation
        (id,subject_sha256,scope_kind,owner_id,contact_id,target_id) VALUES($1,$2,'contact',$3,$4,$4)`,
      [operation,subject,owner,contact]);
      if(present){
        await client.query(`UPDATE public.source_document SET status='delete_requested',deletion_operation_id=$3,deletion_error_code=NULL
          WHERE owner_id=$1 AND contact_id=$2 AND status='active'`,[owner,contact,operation]);
        await cancelScopedTasks(client,owner,contact);
      }
      await captureAssistantRuntimeScope(client,operation,owner,contact);
      return {id:operation,scope_kind:'contact',owner_id:owner,contact_id:contact,target_id:contact,status:'queued',phase:'invalidate'} as Row;
    });
    await this.executeContact(operation);
    return {status:202,body:{operation_id:operation.id}};
  }

  private executeContact(operation:Row):Promise<void>{return withAssistantRuntimeErasure(operation.id,()=>this.eraseContact(operation));}

  private async eraseContact(operation:Row):Promise<void>{
    const claimed=await this.claim(operation.id);
    if(!claimed)return;
    try{
      await this.runtime?.drain(claimed.id);
      await this.storage.businessTransaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${claimed.owner_id}:${claimed.contact_id}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${claimed.owner_id}`]);
        await this.assertLease(client,claimed);
        const present=(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2 FOR UPDATE',[claimed.owner_id,claimed.contact_id])).rowCount;
        await eraseManagedUpdateBackups(client,this.storage.runtimeEnvironment());
        await eraseManagedMedia(client,claimed.owner_id,claimed.contact_id,null);
        await client.query('DELETE FROM public.media_request_tombstone WHERE owner_id=$1 AND contact_id=$2',
          [claimed.owner_id,claimed.contact_id]);
        if(present){
          const removed=await collectContactDependencies(client,claimed.owner_id,claimed.contact_id);
          await cancelScopedTasks(client,claimed.owner_id,claimed.contact_id);
          for(const skill of(await client.query('SELECT id FROM public.reply_skill WHERE owner_id=$1 AND contact_id=$2',[claimed.owner_id,claimed.contact_id])).rows){
            await queueSkillFileCleanup(client,skill.id);
          }
          await client.query(`UPDATE public.source_document SET status='delete_requested',deletion_operation_id=$3,deletion_error_code=NULL
            WHERE owner_id=$1 AND contact_id=$2 AND status='active'`,[claimed.owner_id,claimed.contact_id,claimed.id]);
          await eraseSourceTraces(client,claimed.owner_id,removed,claimed.contact_id);
          await eraseMemoryDependencies(client,claimed.owner_id,removed);
          await deleteSourceReplies(client,claimed.owner_id,removed,claimed.contact_id,true);
          await eraseSourcePreferences(client,claimed.owner_id,removed);
          await eraseContactPreferences(client,claimed.owner_id,claimed.contact_id);
          await shrinkMemorySources(client,claimed.owner_id,claimed.contact_id,removed);
          await client.query('DELETE FROM public.outbound_ledger_entry WHERE owner_id=$1 AND contact_id=$2',[claimed.owner_id,claimed.contact_id]);
          await client.query('DELETE FROM public.contact WHERE owner_id=$1 AND id=$2',[claimed.owner_id,claimed.contact_id]);
        }
        await client.query("UPDATE public.cross_domain_deletion_operation SET phase='verify',updated_at=now() WHERE id=$1",[claimed.id]);
      });
      await this.cleanupRuntime(claimed);
      await this.cleanupFiles(claimed.owner_id);
      await this.complete(claimed,'contact');
    }catch(error){
      await this.fail(claimed,error).catch(()=>{});
    }
  }

  private async deleteAccount(owner:string,body:unknown):Promise<CrossDomainDeletionResponse>{
    if(!body||typeof body!=='object'||Array.isArray(body)
      ||Object.keys(body).sort().join(',')!=='confirm_scope,confirmed'
      ||(body as Row).confirmed!==true||(body as Row).confirm_scope!=='account'){
      throw new CrossDomainDeletionError('deletion_confirmation_required',400);
    }
    const subject=scopeKey(owner,['account']);
    const operation=await this.storage.businessTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      const existing=(await client.query('SELECT * FROM public.cross_domain_deletion_operation WHERE subject_sha256=$1 FOR UPDATE',[subject])).rows[0];
      if(existing)return existing;
      if(!(await client.query('SELECT 1 FROM public.owner WHERE id=$1 FOR UPDATE',[owner])).rowCount){
        throw new CrossDomainDeletionError('account_not_found',404);
      }
      const operation=randomUUID();
      await client.query(`INSERT INTO public.cross_domain_deletion_operation
        (id,subject_sha256,scope_kind,owner_id,contact_id,target_id) VALUES($1,$2,'account',$3,NULL,$3)`,
      [operation,subject,owner]);
      await client.query(`UPDATE public.source_document SET status='delete_requested',deletion_operation_id=$2,deletion_error_code=NULL
        WHERE owner_id=$1 AND status='active'`,[owner,operation]);
      await client.query(`UPDATE public.background_task_step step
        SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,last_error_code='account_deleted',finished_at=now(),updated_at=now()
        FROM public.background_task task
        WHERE task.id=step.task_id AND task.owner_id=$1 AND step.status<>'succeeded'`,[owner]);
      await client.query(`UPDATE public.background_task SET status='cancelled',last_error_code='account_deleted',finished_at=now(),updated_at=now()
        WHERE owner_id=$1 AND status IN ('queued','running','verifying','failed')`,[owner]);
      await captureAssistantRuntimeScope(client,operation,owner);
      return {id:operation,scope_kind:'account',owner_id:owner,contact_id:null,target_id:owner,status:'queued',phase:'invalidate'} as Row;
    });
    await this.executeAccount(operation);
    return {status:202,body:{operation_id:operation.id}};
  }

  private executeAccount(operation:Row):Promise<void>{return withAssistantRuntimeErasure(operation.id,()=>this.eraseAccount(operation));}

  private async eraseAccount(operation:Row):Promise<void>{
    const claimed=await this.claim(operation.id);
    if(!claimed)return;
    try{
      await this.runtime?.drain(claimed.id);
      await this.storage.businessTransaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${claimed.owner_id}`]);
        await this.assertLease(client,claimed);
        if(!(await client.query('SELECT 1 FROM public.owner WHERE id=$1 FOR UPDATE',[claimed.owner_id])).rowCount)return;
        const removed=await collectAccountDependencies(client,claimed.owner_id);
        await eraseManagedUpdateBackups(client,this.storage.runtimeEnvironment());
        await eraseManagedMedia(client,claimed.owner_id,null,null);
        await client.query('DELETE FROM public.media_request_tombstone WHERE owner_id=$1',[claimed.owner_id]);
        for(const skill of(await client.query('SELECT id FROM public.reply_skill WHERE owner_id=$1',[claimed.owner_id])).rows){
          await queueSkillFileCleanup(client,skill.id);
        }
        const packages=this.files.scan(claimed.owner_id);
        if(packages.rootFailed||packages.failedNames.length)throw new CrossDomainDeletionError('skill_file_cleanup_required',409);
        for(const pkg of packages.packages){
          await client.query('INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES($1) ON CONFLICT DO NOTHING',
            [`${claimed.owner_id}/${pkg.name}`]);
        }
        await client.query(`UPDATE public.background_task_step step
          SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,last_error_code='account_deleted',finished_at=now(),updated_at=now()
          FROM public.background_task task
          WHERE task.id=step.task_id AND task.owner_id=$1 AND step.status<>'succeeded'`,[claimed.owner_id]);
        await client.query(`UPDATE public.background_task SET status='cancelled',last_error_code='account_deleted',finished_at=now(),updated_at=now()
          WHERE owner_id=$1 AND status IN ('queued','running','verifying','failed')`,[claimed.owner_id]);
        await client.query(`UPDATE public.source_document SET status='delete_requested',deletion_operation_id=$2,deletion_error_code=NULL
          WHERE owner_id=$1 AND status='active'`,[claimed.owner_id,claimed.id]);
        await eraseSourceTraces(client,claimed.owner_id,removed,null);
        await eraseMemoryDependencies(client,claimed.owner_id,removed);
        await deleteSourceReplies(client,claimed.owner_id,removed,null,true);
        await eraseSourcePreferences(client,claimed.owner_id,removed);
        await client.query('DELETE FROM public.outbound_ledger_entry WHERE owner_id=$1',[claimed.owner_id]);
        await client.query('DELETE FROM public.owner WHERE id=$1',[claimed.owner_id]);
        await client.query("UPDATE public.cross_domain_deletion_operation SET phase='verify',updated_at=now() WHERE id=$1",[claimed.id]);
      });
      await this.cleanupRuntime(claimed);
      await this.cleanupFiles(claimed.owner_id);
      await this.complete(claimed,'account');
    }catch(error){
      await this.fail(claimed,error).catch(()=>{});
    }
  }

  private async claim(operation:string):Promise<Row|null>{
    return this.storage.businessTransaction(async client=>(await client.query(`UPDATE public.cross_domain_deletion_operation
      SET status='running',phase='erase',lease_expires_at=now()+interval '60 seconds',
        lease_generation=lease_generation+1,updated_at=now(),error_code=NULL,finished_at=NULL
      WHERE id=$1 AND(status IN ('queued','failed') OR(status='running' AND lease_expires_at<=now()))
      RETURNING *`,[operation])).rows[0]??null);
  }

  private async assertLease(client:pg.Client,operation:Row):Promise<void>{
    if(!(await client.query(`SELECT 1 FROM public.cross_domain_deletion_operation
      WHERE id=$1 AND status='running' AND lease_generation=$2 FOR UPDATE`,
    [operation.id,operation.lease_generation])).rowCount)throw new CrossDomainDeletionError('deletion_lease_lost',409);
  }

  private async complete(operation:Row,scope:'contact'|'account'|'discussion'):Promise<void>{
    const verified=await this.storage.businessTransaction(async client=>{
      await this.assertLease(client,operation);
      if(scope==='contact'){
        if((await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',[operation.owner_id,operation.contact_id])).rowCount)
          throw new CrossDomainDeletionError('deletion_verification_failed',409);
        if((await client.query('SELECT 1 FROM public.outbound_ledger_entry WHERE owner_id=$1 AND contact_id=$2 LIMIT 1',[operation.owner_id,operation.contact_id])).rowCount)
          throw new CrossDomainDeletionError('deletion_verification_failed',409);
      }else if(scope==='account'){
        if((await client.query('SELECT 1 FROM public.owner WHERE id=$1',[operation.owner_id])).rowCount)
          throw new CrossDomainDeletionError('deletion_verification_failed',409);
        if((await client.query('SELECT 1 FROM public.outbound_ledger_entry WHERE owner_id=$1 LIMIT 1',[operation.owner_id])).rowCount)
          throw new CrossDomainDeletionError('deletion_verification_failed',409);
      }else if((await client.query('SELECT 1 FROM public.assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3',
        [operation.owner_id,operation.contact_id,operation.target_id])).rowCount){
        throw new CrossDomainDeletionError('deletion_verification_failed',409);
      }
      await this.finishRuntimeTargets(client,operation.id);
      const completed=(await client.query(`UPDATE public.cross_domain_deletion_operation
        SET status='succeeded',phase='complete',owner_id=NULL,contact_id=NULL,target_id=NULL,lease_expires_at=NULL,error_code=NULL,finished_at=now(),updated_at=now()
        WHERE id=$1 AND status='running' AND lease_generation=$2`,[operation.id,operation.lease_generation])).rowCount;
      if(completed!==1)throw new CrossDomainDeletionError('deletion_lease_lost',409);
      return true;
    });
    if(!verified)throw new CrossDomainDeletionError('deletion_verification_failed',409);
  }

  private async finishRuntimeTargets(client:pg.Client,id:string):Promise<void>{
    if((await client.query('SELECT 1 FROM assistant_runtime_deletion_target WHERE operation_id=$1 AND NOT cleaned LIMIT 1',[id])).rowCount)throw new CrossDomainDeletionError('assistant_runtime_cleanup_required',409);
    await client.query('DELETE FROM assistant_runtime_deletion_target WHERE operation_id=$1',[id]);
  }

  private async fail(operation:Row,error:unknown):Promise<void>{
    const code=error instanceof HostStorageError?error.code:'deletion_execution_failed';
    await this.storage.businessTransaction(async client=>{
      await client.query(`UPDATE public.cross_domain_deletion_operation
        SET status='failed',phase='verify',error_code=$2,lease_expires_at=NULL,finished_at=now(),updated_at=now()
        WHERE id=$1 AND status='running' AND lease_generation=$3`,[operation.id,code,operation.lease_generation]);
    });
  }

  private async cleanupRuntime(operation:Row):Promise<void>{
    const targets=await this.storage.businessReadTransaction(async client=>(await client.query('SELECT * FROM assistant_runtime_deletion_target WHERE operation_id=$1',[operation.id])).rows);
    if(targets.length&&!this.runtime)throw new CrossDomainDeletionError('assistant_runtime_cleanup_required',409);
    await this.runtime?.cleanup(operation.id);
  }

  private async cleanupFiles(owner:string):Promise<void>{
    try{
      await this.storage.businessTransaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
        await queueUnreferencedPreferenceFiles(client,owner,this.files);
        await cleanupSkillFiles(client,owner,this.files);
        if((await client.query(`SELECT 1 FROM public.reply_skill_file_cleanup
          WHERE split_part(relative_path,'/',1)=$1
             OR(split_part(relative_path,'/',1) IN('.versions','.staging') AND split_part(relative_path,'/',2)=$1)
          LIMIT 1`,[owner])).rowCount)throw new CrossDomainDeletionError('skill_file_cleanup_required',409);
      });
    }catch(error){
      if(error instanceof CrossDomainDeletionError)throw error;
      throw new CrossDomainDeletionError('skill_file_cleanup_required',409);
    }
  }

  private async retry(owner:string,operation:string):Promise<CrossDomainDeletionResponse>{
    const row=await this.storage.businessReadTransaction(async client=>(await client.query(`SELECT * FROM public.cross_domain_deletion_operation
      WHERE id=$1 AND(owner_id=$2 OR(status='succeeded' AND owner_id IS NULL))`,[operation,owner])).rows[0]);
    if(!row)throw new CrossDomainDeletionError('deletion_not_found',404);
    if(row.status==='succeeded')return {status:200,body:{operation_id:row.id,status:row.status}};
    if(row.scope_kind==='source')await this.executeSource(row);
    else if(row.scope_kind==='contact')await this.executeContact(row);
    else if(row.scope_kind==='account')await this.executeAccount(row);
    else if(row.scope_kind==='discussion')await this.executeDiscussion(row);
    else throw new CrossDomainDeletionError('deletion_retry_unsupported',409);
    return {status:202,body:{operation_id:row.id,state:'accepted'}};
  }

  /** 宿主启动时接管已过租约的上次进程现场；失败项只供用户明确重试。 */
  async recover():Promise<number>{
    let recovered=0;
    const seen=new Set<string>();
    while(true){
      const rows=await this.storage.businessReadTransaction(async client=>(await client.query(`SELECT *
        FROM public.cross_domain_deletion_operation
        WHERE owner_id=$1 AND NOT id=ANY($2::uuid[])
          AND(status='queued' OR(status='running' AND lease_expires_at<=now()))
        ORDER BY created_at,id LIMIT 32`,[this.owner,[...seen]])).rows);
      if(!rows.length)return recovered;
      for(const row of rows){
        seen.add(row.id);
        try{
          if(row.scope_kind==='source')await this.executeSource(row);
          else if(row.scope_kind==='contact')await this.executeContact(row);
          else if(row.scope_kind==='account')await this.executeAccount(row);
          else if(row.scope_kind==='discussion')await this.executeDiscussion(row);
        }catch{}
      }
      recovered+=rows.length;
    }
  }

  private async failSource(operation:Row,code:string):Promise<void>{
    await this.storage.businessTransaction(async client=>{
      const current=(await client.query(`SELECT 1 FROM public.cross_domain_deletion_operation
        WHERE id=$1 AND status='running' AND lease_generation=$2 FOR UPDATE`,[operation.id,operation.lease_generation])).rowCount;
      if(!current)return;
      if(operation.source_kind==='source_document'){
        await client.query(`UPDATE public.source_document SET status='delete_failed',deletion_operation_id=NULL,deletion_error_code=$4
          WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status<>'deleted'`,[operation.owner_id,operation.contact_id,operation.target_id,code]);
        await client.query(`UPDATE public.background_task_step SET status='failed',last_error_code=$2,finished_at=now()
          WHERE task_id=$1 AND status<>'succeeded'`,[operation.id,code]);
        await client.query(`UPDATE public.background_task SET status='failed',last_error_code=$2,finished_at=now(),updated_at=now() WHERE id=$1`,[operation.id,code]);
      }
      await client.query(`UPDATE public.cross_domain_deletion_operation SET status='failed',phase='verify',error_code=$2,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE id=$1`,[operation.id,code]);
    });
  }

  private async read(owner:string,operation:string):Promise<CrossDomainDeletionResponse>{
    const row=await this.storage.businessReadTransaction(async client=>(await client.query(`SELECT id,scope_kind,status,phase,error_code,contact_id,target_id,created_at,updated_at,finished_at
      FROM public.cross_domain_deletion_operation WHERE id=$1 AND(owner_id=$2 OR(status='succeeded' AND owner_id IS NULL))`,[operation,owner])).rows[0]);
    if(!row)throw new CrossDomainDeletionError('deletion_not_found',404);
    return {status:200,body:publicOperation(row)};
  }
  private async list(owner:string,contact:string|null=null):Promise<CrossDomainDeletionResponse>{
    const rows=await this.storage.businessReadTransaction(async client=>(await client.query(`SELECT id,scope_kind,status,phase,error_code,contact_id,target_id,created_at,updated_at,finished_at
      FROM public.cross_domain_deletion_operation WHERE owner_id=$1 AND ($2::uuid IS NULL OR(contact_id=$2 AND scope_kind='discussion' AND status<>'succeeded')) ORDER BY created_at DESC,id DESC LIMIT 50`,[owner,contact])).rows);
    return {status:200,body:{operations:rows.map(publicOperation)}};
  }
}

function publicOperation(row:Row){
  if(!statuses.has(row.status)||!phases.has(row.phase))throw new CrossDomainDeletionError('deletion_result_invalid',500);
  return {operation_id:row.id,scope_kind:row.scope_kind,status:row.status,phase:row.phase,error_code:row.error_code,
    ...(row.status!=='succeeded'?{contact_id:row.contact_id,target_id:row.target_id}:{}),
    created_at:row.created_at,updated_at:row.updated_at,finished_at:row.finished_at};
}

async function eraseSourceClosure(client:pg.Client,owner:string,contact:string,sourceKind:SourceKind,source:string):Promise<void>{
  const sourceColumn=sourceKind==='source_document'?'source_document_id':'observation_id';
  await client.query(`INSERT INTO public.wechat_auto_read_suppression(owner_id,contact_id,external_local_id,identity_create_time)
    SELECT DISTINCT metadata.owner_id,metadata.contact_id,metadata.external_local_id,coalesce(metadata.source_create_time,-1)
    FROM public.wechat_message_metadata metadata
    JOIN public.message_source_ref ref ON ref.owner_id=metadata.owner_id AND ref.contact_id=metadata.contact_id AND ref.message_id=metadata.message_id
    WHERE metadata.owner_id=$1 AND metadata.contact_id=$2 AND ref.source_kind=$3 AND ref.${sourceColumn}=$4
    ON CONFLICT DO NOTHING`,[owner,contact,sourceKind,source]);
  await client.query(`UPDATE public.background_task_step step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,
      last_error_code='source_deleted',finished_at=now(),updated_at=now()
    FROM public.background_task task
    WHERE task.id=step.task_id AND task.owner_id=$1 AND task.contact_id=$2 AND task.source_document_id=$3
      AND task.task_type='import' AND step.status<>'succeeded'`,[owner,contact,
      sourceKind==='source_document'?source:null]);
  await client.query(`UPDATE public.background_task SET status='cancelled',last_error_code='source_deleted',finished_at=now(),updated_at=now()
    WHERE owner_id=$1 AND contact_id=$2 AND source_document_id=$3 AND task_type='import' AND status IN ('queued','running','verifying')`,[owner,contact,source]);
  const batches=(await client.query(`SELECT batch_id FROM public.source_processing_batch
    WHERE owner_id=$1 AND contact_id=$2 AND source_kind=$3 AND source_id=$4 FOR UPDATE`,
  [owner,contact,sourceKind,source])).rows.map(row=>row.batch_id);
  if(batches.length){
    await client.query(`INSERT INTO public.source_processing_capture_tombstone(owner_id,contact_id,capture_record_id)
      SELECT owner_id,contact_id,(payload->>'capture_record_id')::uuid
      FROM public.source_processing_record
      WHERE owner_id=$1 AND contact_id=$2 AND batch_id=ANY($3::uuid[]) AND payload->>'capture_record_id' IS NOT NULL
      ON CONFLICT DO NOTHING`,[owner,contact,batches]);
    await client.query(`UPDATE public.source_processing_record SET payload=NULL,locator=NULL,outcome='deleted'
      WHERE owner_id=$1 AND contact_id=$2 AND batch_id=ANY($3::uuid[])`,[owner,contact,batches]);
    await client.query(`UPDATE public.source_processing_batch SET status='deleted',deleted_at=coalesce(deleted_at,now())
      WHERE owner_id=$1 AND contact_id=$2 AND batch_id=ANY($3::uuid[])`,[owner,contact,batches]);
  }
  const touchedMessages=(await client.query(`SELECT DISTINCT message_id FROM public.message_source_ref
    WHERE owner_id=$1 AND contact_id=$2 AND source_kind=$3 AND ${sourceColumn}=$4`,
  [owner,contact,sourceKind,source])).rows.map(row=>row.message_id);
  await client.query(`DELETE FROM public.message_source_ref
    WHERE owner_id=$1 AND contact_id=$2 AND source_kind=$3 AND ${sourceColumn}=$4`,
  [owner,contact,sourceKind,source]);
  const orphanMessages=touchedMessages.length
    ?(await client.query(`SELECT message.id FROM public.message message
      WHERE message.owner_id=$1 AND message.contact_id=$2 AND message.id=ANY($3::uuid[])
        AND NOT EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.message_id=message.id)`,
    [owner,contact,touchedMessages])).rows.map(row=>row.id)
    :[];
  const removed=[source,...orphanMessages];
  await eraseSourceTraces(client,owner,removed,contact);
  await eraseMemoryDependencies(client,owner,removed);
  await deleteSourceReplies(client,owner,removed,contact,false);
  await eraseSourcePreferences(client,owner,removed);
  await shrinkMemorySources(client,owner,contact,removed);
  if(await residualSourceDependencies(client,owner,contact,removed))
    throw new CrossDomainDeletionError('deletion_verification_failed',409);
  if(sourceKind==='source_document'){
    await client.query(`UPDATE public.import_confirmation SET channel_identity_id=NULL
      WHERE owner_id=$1 AND contact_id=$2 AND source_document_id=$3`,[owner,contact,source]);
    await client.query(`DELETE FROM public.import_confirmation
      WHERE owner_id=$1 AND contact_id=$2 AND source_document_id=$3`,[owner,contact,source]);
  }
  if(orphanMessages.length)await client.query(`DELETE FROM public.message message
    WHERE message.owner_id=$1 AND message.contact_id=$2 AND message.id=ANY($3::uuid[])
      AND NOT EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.message_id=message.id)`,
  [owner,contact,orphanMessages]);
}

async function residualSourceDependencies(client:pg.Client,owner:string,contact:string,removed:string[]):Promise<boolean>{
  const row=(await client.query(`SELECT
    (SELECT count(*) FROM public.confirmed_memory
      WHERE owner_id=$1 AND contact_id=$2 AND source_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.memory_candidate
      WHERE owner_id=$1 AND contact_id=$2 AND source_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.owner_memory
      WHERE owner_id=$1 AND source_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.expression_preference
      WHERE owner_id=$1 AND source_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.memory_correction_decision
      WHERE owner_id=$1 AND contact_id=$2 AND (evidence->'source_ids') ?| $4::text[])
    +(SELECT count(*) FROM public.reply_context_evidence
      WHERE owner_id=$1 AND contact_id=$2 AND source_ids ?| $4::text[])
    +(SELECT count(*) FROM public.reply_original_source_use
      WHERE owner_id=$1 AND contact_id=$2 AND source_id=ANY($3::uuid[]))
    +(SELECT count(*) FROM public.reply_exploration
      WHERE owner_id=$1 AND contact_id=$2 AND source_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.memory_upgrade_batch
      WHERE owner_id=$1 AND contact_id=$2 AND state<>'invalidated' AND dependency_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.skill_learning_batch
      WHERE owner_id=$1 AND contact_id=$2 AND outcome<>'invalidated' AND dependency_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.skill_review_comparison
      WHERE owner_id=$1 AND state<>'invalidated' AND dependency_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.skill_draft
      WHERE owner_id=$1 AND contact_id=$2 AND status<>'invalidated' AND dependency_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.layered_memory_batch
      WHERE owner_id=$1 AND contact_id=$2 AND dependency_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.layered_memory_feedback
      WHERE owner_id=$1 AND contact_id=$2 AND dependency_ids&&$3::uuid[])
    +(SELECT count(*) FROM public.layered_profile_batch
      WHERE owner_id=$1 AND contact_id=$2 AND dependency_ids&&$3::uuid[])
    AS count`,[owner,contact,removed,removed])).rows[0].count;
  return Number(row)!==0;
}

async function shrinkMemorySources(client:pg.Client,owner:string,contact:string,removed:string[]):Promise<void>{
  if(!removed.length)return;
  await client.query(`UPDATE public.memory_candidate SET dimension_evidence=NULL
    WHERE owner_id=$1 AND contact_id=$2 AND to_jsonb(memory_candidate)->'dimension_evidence' IS NOT NULL
      AND EXISTS(SELECT 1 FROM unnest($3::uuid[]) dependency(id)
        WHERE (to_jsonb(memory_candidate)->'dimension_evidence')::text LIKE '%'||dependency.id::text||'%')`,
  [owner,contact,removed]);
  for(const table of ['confirmed_memory','owner_memory','memory_candidate'] as const){
    const contactCondition=table==='owner_memory'?'':'AND contact_id=$2';
    const rows=(await client.query(`SELECT id,source_ids,
        CASE WHEN to_jsonb(${table})->>'requires_all_sources'='true' THEN 'all'
             ELSE coalesce(to_jsonb(${table})->>'source_dependency_mode','any') END AS dependency_mode
      FROM public.${table}
      WHERE owner_id=$1 ${contactCondition} AND source_ids && $${table==='owner_memory'?2:3}::uuid[] FOR UPDATE`,
    table==='owner_memory'?[owner,removed]:[owner,contact,removed])).rows;
    for(const row of rows){
      const remaining:unknown[]=row.dependency_mode==='all'
        ?[]
        :(row.source_ids as unknown[]).filter(value=>!removed.includes(String(value)));
      if(remaining.length){
        if(table==='memory_candidate')await client.query(`UPDATE public.memory_candidate SET source_ids=$2::uuid[],updated_at=now()
          WHERE owner_id=$1 AND id=$3`,[owner,remaining,row.id]);
        else await client.query(`UPDATE public.${table} SET source_ids=$2::uuid[],revision=revision+1,updated_at=now()
          WHERE owner_id=$1 AND id=$3`,[owner,remaining,row.id]);
        continue;
      }
      if(table==='memory_candidate')await client.query(`UPDATE public.confirmed_memory SET source_candidate_id=NULL
        WHERE owner_id=$1 AND contact_id=$2 AND source_candidate_id=$3`,[owner,contact,row.id]);
      if(table==='confirmed_memory')await client.query(`UPDATE public.confirmed_memory SET supersedes_memory_id=NULL
        WHERE owner_id=$1 AND contact_id=$2 AND supersedes_memory_id=$3`,[owner,contact,row.id]);
      if(table==='owner_memory')await client.query(`UPDATE public.owner_memory SET supersedes_memory_id=NULL
        WHERE owner_id=$1 AND supersedes_memory_id=$2`,[owner,row.id]);
      await client.query(`DELETE FROM public.${table} WHERE owner_id=$1 AND id=$2`,[owner,row.id]);
    }
  }
  await client.query(`UPDATE public.contact_memory_index SET topics='[]'::jsonb,status='stale',updated_at=now()
    WHERE owner_id=$1 AND contact_id=$2`,[owner,contact]);
  await client.query(`INSERT INTO public.contact_memory_state(owner_id,contact_id,memory_revision) VALUES($1,$2,1)
    ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=contact_memory_state.memory_revision+1,updated_at=now()`,
  [owner,contact]);
}

async function collectContactDependencies(client:pg.Client,owner:string,contact:string):Promise<string[]>{
  const queries=[
    'SELECT id FROM public.source_document WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.message WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.memory_candidate WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.assistant_session WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.assistant_session_input WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.assistant_session_turn WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.assistant_candidate_version WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.assistant_candidate_selection WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.reply_request WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.reply_candidate WHERE owner_id=$1 AND contact_id=$2',
    'SELECT id FROM public.reply_skill WHERE owner_id=$1 AND contact_id=$2',
    `SELECT version.id FROM public.reply_skill_version version
      JOIN public.reply_skill skill ON skill.id=version.skill_id
      WHERE skill.owner_id=$1 AND skill.contact_id=$2`,
    'SELECT id FROM public.memory_correction_decision WHERE owner_id=$1 AND contact_id=$2',
  ];
  const ids=new Set<string>([contact]);
  for(const query of queries)for(const row of (await client.query(query,[owner,contact])).rows)ids.add(row.id);
  return [...ids].sort();
}

async function cancelScopedTasks(client:pg.Client,owner:string,contact:string):Promise<void>{
  await client.query(`UPDATE public.background_task_step step
    SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,last_error_code='scope_deleted',finished_at=now(),updated_at=now()
    FROM public.background_task task
    WHERE task.id=step.task_id AND task.owner_id=$1 AND task.contact_id=$2 AND step.status<>'succeeded'`,[owner,contact]);
  await client.query(`UPDATE public.background_task SET status='cancelled',last_error_code='scope_deleted',finished_at=now(),updated_at=now()
    WHERE owner_id=$1 AND contact_id=$2 AND status IN ('queued','running','verifying','failed')`,[owner,contact]);
}

async function collectAccountDependencies(client:pg.Client,owner:string):Promise<string[]>{
  const queries=[
    'SELECT id FROM public.contact WHERE owner_id=$1',
    'SELECT id FROM public.source_document WHERE owner_id=$1',
    'SELECT id FROM public.local_wechat_observation WHERE owner_id=$1',
    'SELECT id FROM public.message WHERE owner_id=$1',
    'SELECT id FROM public.memory_candidate WHERE owner_id=$1',
    'SELECT id FROM public.confirmed_memory WHERE owner_id=$1',
    'SELECT id FROM public.owner_memory WHERE owner_id=$1',
    'SELECT id FROM public.assistant_session WHERE owner_id=$1',
    'SELECT id FROM public.assistant_session_input WHERE owner_id=$1',
    'SELECT id FROM public.assistant_session_turn WHERE owner_id=$1',
    'SELECT id FROM public.assistant_candidate_version WHERE owner_id=$1',
    'SELECT id FROM public.assistant_candidate_selection WHERE owner_id=$1',
    'SELECT id FROM public.reply_request WHERE owner_id=$1',
    'SELECT id FROM public.reply_candidate WHERE owner_id=$1',
    'SELECT id FROM public.reply_skill WHERE owner_id=$1',
    `SELECT version.id FROM public.reply_skill_version version
      JOIN public.reply_skill skill ON skill.id=version.skill_id WHERE skill.owner_id=$1`,
    'SELECT id FROM public.memory_correction_decision WHERE owner_id=$1',
    'SELECT id FROM public.expression_preference WHERE owner_id=$1',
    'SELECT id FROM public.scenario_document_version WHERE owner_id=$1',
    'SELECT id FROM public.layered_profile_version WHERE owner_id=$1',
  ];
  const ids=new Set<string>();
  for(const query of queries)for(const row of (await client.query(query,[owner])).rows)ids.add(row.id);
  return [...ids].sort();
}

async function eraseManagedMedia(client:pg.Client,owner:string,contact:string|null,source:string|null):Promise<void>{
  const filters=['owner_id=$1'];const params:[string,...unknown[]]=[owner];
  if(contact){params.push(contact);filters.push(`contact_id=$${params.length}`);}
  if(source){params.push(source);filters.push(`source_document_id=$${params.length}`);}
  const rows=(await client.query(`SELECT * FROM public.media_attempt WHERE ${filters.join(' AND ')} FOR UPDATE`,params)).rows;
  for(const row of rows){
    try{
      if(typeof row.cache_root!=='string'||!isAbsolute(row.cache_root)||row.cache_root.split(/[\\/]/).includes('..'))throw Error('unsafe');
      const expected=[row.owner_id,row.contact_id,row.source_document_id,row.attempt_id].map(value=>{
        if(typeof value!=='string'||!uuid.test(value))throw Error('identity');
        return value.replaceAll('-','');
      });
      const target=join(row.cache_root,...expected);
      if(existsSync(target)){
        let current=row.cache_root;
        for(const part of ['',...expected]){
          if(part)current=join(current,part);
          const stat=lstatSync(current);
          if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('unsafe');
          if(stat.uid!==process.getuid?.()||(stat.mode&0o077))throw Error('unsafe');
        }
        for(const name of readdirSync(target)){
          const path=join(target,name),stat=lstatSync(path);
          if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('unsafe');
          unlinkSync(path);
        }
        rmdirSync(target);
      }
    }catch{
      throw new CrossDomainDeletionError('media_cleanup_required',409);
    }
    await client.query(`INSERT INTO public.media_request_tombstone(owner_id,contact_id,request_key_hash)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[row.owner_id,row.contact_id,row.request_key_hash]);
  }
  if(rows.length)await client.query(`DELETE FROM public.media_attempt WHERE ${filters.join(' AND ')}`,params);
}
