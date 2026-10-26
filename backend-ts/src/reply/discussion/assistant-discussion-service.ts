import {captureAssistantRuntimeDependencies,assistantRuntimeDeletionPending} from '../runtime/assistant-runtime-erasure.ts';
import {recordAssistantUserActivity,type AssistantClock} from './assistant-user-activity.ts';
/**
 * 助手讨论的 TypeScript 业务责任方。
 *
 * PostgreSQL 保存可重开的讨论、输入版本、候选版本、显式选择和来源依赖；
 * 这里不创建 DSH Session、不保存运行 checkpoint，也不调用模型。
 */
import type {Client} from 'pg';
import {SkillFiles} from '../../skills/skill-files.ts';
import {createReplySkillGuards} from '../generation/reply-skill-guards.ts';
import {createReplyAssistantGuards} from '../generation/reply-assistant-factory.ts';
import {readStoredReplyResult,ReplyStoreError} from '../generation/reply-store.ts';
import {replyGeneratedPayload} from '../generation/reply-result.ts';
import {eraseManagedUpdateBackups,queueUnreferencedPreferenceFiles} from '../../preferences/preference-files.ts';
import {deleteSourceReplies} from '../../preferences/preference-erasure.ts';
import {cleanupSkillFiles,eraseSkillLearning} from '../../skills/skill-cleanup.ts';
import {
  canonical,
  fingerprint,
  inputRows,
  legacyJson,
} from '../generation/reply-assistant-erasure.ts';

type Row=Record<string,any>;
export interface AssistantDiscussionScope {owner_id:string;contact_id:string}
export interface AssistantDiscussionMessage {message_id:string;text:string}
export interface AssistantDiscussionEdit {
  edit_key:string;parent_version_id:string;messages:AssistantDiscussionMessage[];requirements?:string|null;
}
export interface AssistantDiscussionSelectionCommand {
  expected_selection_id:string;candidate_id:string;version_id:string;
}
export interface AssistantDiscussionInput {
  type:'response_exploration'|'purpose_exploration';
  target_message_id?:string;purpose_hint?:string;
  correction?:string;requirements?:string;answer?:string;confirmed_intent?:string;
  skill_mode?:'auto'|'disabled'|'user';skill_version_id?:string|null;skill_scene?:string;
}
export interface AssistantDiscussionServiceOptions {
  transaction<T>(work:(client:Client)=>Promise<T>):Promise<T>;
  skillsRoot:string;
  assistantClock?:AssistantClock;
  eraseRuntime?:(client:Client,scope:AssistantDiscussionScope,sessionId:string)=>Promise<void>;
  environment?:NodeJS.ProcessEnv;
  resolveBinding?:(client:Client,scope:AssistantDiscussionScope,allowManual:boolean)=>Promise<string>;
}

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashPattern=/^[0-9a-f]{64}$/;
const activeMessage=`EXISTS(SELECT 1 FROM message_source_ref ref WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND (ref.observation_id IS NOT NULL OR EXISTS(SELECT 1 FROM source_document source WHERE source.id=ref.source_document_id AND source.owner_id=ref.owner_id AND source.contact_id=ref.contact_id AND source.status='active')))`;
const exactUuid=(value:unknown):value is string=>typeof value==='string'&&uuidPattern.test(value);
const text=(value:unknown,limit=65536,blank=false):value is string=>typeof value==='string'&&[...value].length<=limit&&(blank||Boolean(value.trim()));
const scopeOf=(scope:AssistantDiscussionScope):AssistantDiscussionScope=>({
  owner_id:scope.owner_id, contact_id:scope.contact_id,
});
const reject=(code:string,reason?:string):never=>{
  throw new AssistantDiscussionError(code,reason);
};
const iso=(value:unknown):string=>value instanceof Date?value.toISOString():String(value);
const messages=(value:unknown):AssistantDiscussionMessage[]=>{
  if(!Array.isArray(value)||value.length<1||value.length>8)reject('candidate_invalid');
  const result=(value as Row[]).map((item)=>{
    if(!item||typeof item!=='object'||Object.keys(item).sort().join(',')!=='message_id,text'
      ||!exactUuid(item.message_id)||!text(item.text))reject('candidate_invalid');
    return {message_id:item.message_id.toLowerCase(),text:item.text};
  });
  if(new Set(result.map(item=>item.message_id)).size!==result.length)reject('candidate_invalid');
  return result;
};

export class AssistantDiscussionError extends Error {
  readonly code:string;
  readonly reason:string|null;
  readonly status:number;
  constructor(code:string,reason?:string,status?:number){
    super(reason?`${code}:${reason}`:code);
    this.name='AssistantDiscussionError';
    this.code=code;
    this.reason=reason??null;
    this.status=status??(code==='not_found'?404:code==='conflict'||code==='in_progress'?409:code==='invalid'?400:code==='unavailable'?503:409);
  }
}

function normalizeDiscussionInput(value:AssistantDiscussionInput):Row{
  if(!value||typeof value!=='object'||Array.isArray(value))reject('invalid');
  const type=value.type;
  const allowed=type==='response_exploration'
    ?new Set(['type','target_message_id','correction','requirements','answer','confirmed_intent','skill_mode','skill_version_id','skill_scene'])
    :type==='purpose_exploration'
      ?new Set(['type','purpose_hint','correction','requirements','answer','confirmed_intent','skill_mode','skill_version_id','skill_scene'])
      :reject('invalid');
  if(Object.keys(value).some(key=>!allowed.has(key)))reject('invalid');
  let normalized:Row;
  if(type==='response_exploration'){
    if(!exactUuid(value.target_message_id))reject('invalid');
    normalized={type,target_message_id:(value.target_message_id as string).toLowerCase()};
  }else{
    if(!text(value.purpose_hint,4096,true))reject('invalid');
    normalized={type,purpose_hint:value.purpose_hint};
  }
  for(const field of ['correction','requirements','answer','confirmed_intent']){
    const item=value[field as keyof AssistantDiscussionInput]??'';
    if(typeof item!=='string'||[...item].length>4096)reject('invalid');
    normalized[field]=item;
  }
  const mode=value.skill_mode??'auto';
  if(!['auto','disabled','user'].includes(mode as string))reject('invalid');
  if(mode==='user'){
    if(!exactUuid(value.skill_version_id))reject('invalid');
    normalized.skill_version_id=(value.skill_version_id as string).toLowerCase();
  }else if(value.skill_version_id!=null)reject('invalid');
  else normalized.skill_version_id=null;
  normalized.skill_mode=mode;
  if(value.skill_scene!==undefined){
    if(!text(value.skill_scene,256)||value.skill_scene!==value.skill_scene.trim())reject('invalid');
    normalized.skill_scene=value.skill_scene;
  }
  return normalized;
}

export class AssistantDiscussionService {
  private readonly options:AssistantDiscussionServiceOptions;
  private readonly files:SkillFiles;
  private readonly assistant:ReturnType<typeof createReplyAssistantGuards>['assistant'];
  private readonly ports:ReturnType<typeof createReplyAssistantGuards>['ports'];

  constructor(options:AssistantDiscussionServiceOptions){
    if(typeof options?.transaction!=='function'||typeof options.skillsRoot!=='string'||!options.skillsRoot.trim())reject('unavailable');
    this.options=options;
    this.files=new SkillFiles(options.skillsRoot);
    const savedSkill=createReplySkillGuards({files:this.files});
    const guards=createReplyAssistantGuards(
      savedSkill,
      (client,scope)=>this.activeBinding(client,scope,true),
    );
    this.assistant=guards.assistant;
    this.ports=guards.ports;
  }

  private async transaction<T>(scope:AssistantDiscussionScope,work:(client:Client)=>Promise<T>,read=false):Promise<T>{
    this.scope(scope);
    try{
      return await this.options.transaction(async client=>{
        // 同范围读取共享来源锁；写入和删除继续排他，防止复验期间来源改变。
        await client.query(`SELECT ${read?'pg_advisory_xact_lock_shared':'pg_advisory_xact_lock'}(hashtextextended($1,0))`,[`owner:${scope.owner_id}`]);
        return work(client);
      });
    }catch(error){
      if(error instanceof AssistantDiscussionError)throw error;
      if(error instanceof ReplyStoreError)reject('conflict',error.code);
      return reject('unavailable');
    }
  }

  private scope(scope:AssistantDiscussionScope):void{
    if(!scope||typeof scope!=='object'||!exactUuid(scope.owner_id)||!exactUuid(scope.contact_id))reject('invalid');
  }

  private async contact(client:Client,scope:AssistantDiscussionScope,lock=false):Promise<void>{
    const row=(await client.query(
      `SELECT 1 FROM contact WHERE owner_id=$1 AND id=$2${lock?' FOR SHARE':''}`,
      [scope.owner_id,scope.contact_id],
    )).rows[0];
    if(!row)reject('not_found');
  }

  private async activeBinding(
    client:Client,
    scope:AssistantDiscussionScope,
    allowManual:boolean,
  ):Promise<string>{
    if(this.options.resolveBinding)return this.options.resolveBinding(client,scope,allowManual);
    const bindings=(await client.query(
      "SELECT id FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active' FOR SHARE",
      [scope.owner_id,scope.contact_id],
    )).rows;
    if(bindings.length>1)reject('conflict','binding_ambiguous');
    if(bindings.length===1)return bindings[0].id;
    if(!allowManual)reject('conflict','no_active_binding');
    const manual=(await client.query(
      'SELECT id FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 FOR SHARE',
      [scope.owner_id,scope.contact_id],
    )).rows;
    if(manual.length!==1)reject('conflict','no_active_binding');
    return manual[0].id;
  }

  private async sessionRow(
    client:Client,
    scope:AssistantDiscussionScope,
    sessionId:string,
    lock=false,
  ):Promise<Row>{
    if(!exactUuid(sessionId))reject('invalid');
    const row=(await client.query(
      `SELECT * FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3${lock?' FOR UPDATE':''}`,
      [scope.owner_id,scope.contact_id,sessionId],
    )).rows[0];
    if(!row)reject('not_found');
    return row;
  }

  private async candidateRow(
    client:Client,
    scope:AssistantDiscussionScope,
    sessionId:string,
    candidateId:string,
  ):Promise<Row>{
    if(!exactUuid(sessionId)||!exactUuid(candidateId))reject('invalid');
    const row=(await client.query(`
      SELECT candidate.id,candidate.reply_request_id,candidate.ordinal,
             candidate.message_group,
             to_char(candidate.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
             turn.id AS turn_id,turn.input_version_id,turn.state AS turn_state,
             turn.input_payload,turn.dependency_ids AS turn_dependencies,
             request.state AS request_state,request.idempotency_key
        FROM reply_candidate candidate
        JOIN reply_request request
          ON request.id=candidate.reply_request_id
         AND request.owner_id=candidate.owner_id
         AND request.contact_id=candidate.contact_id
         AND request.conversation_binding_id=candidate.conversation_binding_id
        JOIN assistant_session_turn turn
          ON turn.reply_request_id=request.id
         AND turn.owner_id=candidate.owner_id
         AND turn.contact_id=candidate.contact_id
         AND turn.conversation_binding_id=candidate.conversation_binding_id
       WHERE candidate.owner_id=$1 AND candidate.contact_id=$2
         AND candidate.id=$3 AND turn.session_id=$4
       FOR SHARE OF candidate,turn,request`,
    [scope.owner_id,scope.contact_id,candidateId,sessionId])).rows[0];
    if(!row)reject('not_found');
    if((await client.query(
      'SELECT 1 FROM reply_invalidated_key WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',
      [scope.owner_id,scope.contact_id,row.idempotency_key],
    )).rowCount)reject('conflict','request_invalidated');
    if(row.turn_state!=='completed'||row.request_state!=='completed'||row.input_payload===null)reject('conflict','candidate_unavailable');
    try{
      await this.assistant.verifiedDiscussionDependencies(
        client,scopeOf(scope),row.turn_dependencies??[],true,
      );
      await this.ports.requireReplySourcesCurrent(
        client,scopeOf(scope),row.reply_request_id,true,
      );
      await this.ports.requireSavedSkillPolicy(
        client,scopeOf(scope),row.reply_request_id,
      );
    }catch{
      reject('conflict','source_unavailable');
    }
    return row;
  }

  private async ensureOriginal(
    client:Client,
    scope:AssistantDiscussionScope,
    sessionId:string,
    candidate:Row,
  ):Promise<void>{
    await client.query(`
      INSERT INTO assistant_candidate_version(
        id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,0,$7)
      ON CONFLICT(candidate_id,version_number) DO NOTHING`,
    [candidate.id,scope.owner_id,scope.contact_id,sessionId,candidate.turn_id,candidate.id,candidate.created_at]);
  }

  private async history(
    client:Client,
    scope:AssistantDiscussionScope,
    sessionId:string,
    candidate:Row,
  ):Promise<Row>{
    const rows=(await client.query(`
      SELECT id,version_number,parent_version_id,edit_key,message_group,requirements,
             to_char(created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at
        FROM assistant_candidate_version
       WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND candidate_id=$4
       ORDER BY version_number`,
    [scope.owner_id,scope.contact_id,sessionId,candidate.id])).rows;
    const original=messages(candidate.message_group);
    const versions=rows.length&&Number(rows[0].version_number)===0
      ?rows
      :[{id:candidate.id,version_number:0,parent_version_id:null,edit_key:null,
        message_group:candidate.message_group,requirements:null,created_at:candidate.created_at},...rows];
    const selected=(await client.query(`
      SELECT version_id FROM assistant_candidate_selection
       WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3
         AND candidate_id=$4 AND is_current`,
    [scope.owner_id,scope.contact_id,sessionId,candidate.id])).rows[0];
    const basis=await this.ports.readReplyBasisChanges(
      client,scopeOf(scope),candidate.reply_request_id,
    );
    return {
      session_id:sessionId,
      turn_id:candidate.turn_id,
      candidate_id:candidate.id,
      candidate_group_id:candidate.reply_request_id,
      candidate_number:Number(candidate.ordinal)+1,
      default_display_version_id:versions.at(-1).id,
      selected_version_id:selected?.version_id??null,
      ...(basis.length?{basis_changes:basis}:{}),
      versions:versions.map((version:Row)=>{
        const group=Number(version.version_number)===0?original:messages(version.message_group);
        return {
          version_id:version.id,
          version_number:Number(version.version_number),
          parent_version_id:version.parent_version_id??null,
          edit_key:version.edit_key??null,
          text:group.map(item=>item.text).join('\n\n'),
          messages:group,
          requirements:version.requirements??null,
          created_at:iso(version.created_at),
        };
      }),
    };
  }

  async requireBinding(scope:AssistantDiscussionScope):Promise<void>{
    await this.transaction(scope,async client=>{
      await this.contact(client,scope);
      await this.activeBinding(client,scope,false);
    });
  }

  async defaultSession(scope:AssistantDiscussionScope):Promise<string>{
    return this.transaction(scope,async client=>{
      await this.contact(client,scope);
      await this.activeBinding(client,scope,true);
      return (await client.query(`
        INSERT INTO assistant_session(owner_id,contact_id)
        VALUES($1,$2)
        ON CONFLICT(owner_id,contact_id) WHERE is_default
        DO UPDATE SET updated_at=assistant_session.updated_at
        RETURNING id`,[scope.owner_id,scope.contact_id])).rows[0].id;
    });
  }

  async createSession(scope:AssistantDiscussionScope):Promise<string>{
    return this.transaction(scope,async client=>{
      await this.contact(client,scope);
      await this.activeBinding(client,scope,true);
      await client.query(
        'UPDATE assistant_session SET is_default=FALSE WHERE owner_id=$1 AND contact_id=$2 AND is_default',
        [scope.owner_id,scope.contact_id],
      );
      return (await client.query(
        'INSERT INTO assistant_session(owner_id,contact_id,is_default,last_user_activity_at) VALUES($1,$2,TRUE,COALESCE($3::timestamptz,clock_timestamp())) RETURNING id',
        [scope.owner_id,scope.contact_id,await this.options.assistantClock?.()??null],
      )).rows[0].id;
    });
  }

  async listSessions(scope:AssistantDiscussionScope):Promise<{sessions:{session_id:string;is_current:boolean;last_user_activity_at:string|null}[];current_session_id:string|null}>{
    return this.transaction(scope,async client=>{
      await this.contact(client,scope);
      const sessions=(await client.query(
        'SELECT id,is_default,last_user_activity_at FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 ORDER BY id',
        [scope.owner_id,scope.contact_id],
      )).rows.map(row=>({session_id:row.id,is_current:row.is_default,last_user_activity_at:row.last_user_activity_at===null?null:iso(row.last_user_activity_at)}));
      return {sessions,current_session_id:sessions.find(row=>row.is_current)?.session_id??null};
    },true);
  }

  async selectSession(scope:AssistantDiscussionScope,sessionId:string):Promise<string>{
    return this.transaction(scope,async client=>{
      await this.contact(client,scope);
      const binding=await this.activeBinding(client,scope,true);
      await this.sessionRow(client,scope,sessionId,true);
      if(await assistantRuntimeDeletionPending(client,scope,sessionId))reject('conflict','deletion_pending');
      for(const row of await inputRows(client,scope.owner_id,scope.contact_id,sessionId)){
        if(row.conversation_binding_id!==binding)reject('conflict','binding_changed');
        if(row.state!=='active')reject('conflict','source_unavailable');
        if(row.input_type==='candidate_carry')await this.carryContent(client,scope,row);
        const dependencies=[...new Set<string>([...(row.dependency_ids??[]),...(row.turn_dependencies??[])])];
        await this.assistant.verifiedDiscussionDependencies(client,scope,dependencies,false);
        await this.ports.requireGenerationMemoryDependencies(client,scope,dependencies);
        if(row.reply_request_id){
          await this.ports.requireReplySourcesCurrent(client,scope,row.reply_request_id,true);
          await this.ports.requireSavedSkillPolicy(client,scope,row.reply_request_id);
        }
      }
      await client.query(
        'UPDATE assistant_session SET is_default=FALSE WHERE owner_id=$1 AND contact_id=$2 AND is_default AND id<>$3',
        [scope.owner_id,scope.contact_id,sessionId],
      );
      await client.query(
        'UPDATE assistant_session SET is_default=TRUE WHERE owner_id=$1 AND contact_id=$2 AND id=$3',
        [scope.owner_id,scope.contact_id,sessionId],
      );
      await recordAssistantUserActivity(client,scope,sessionId,this.options.assistantClock);
      return sessionId;
    });
  }

  async recordInput(
    scope:AssistantDiscussionScope,
    sessionId:string,
    content:AssistantDiscussionInput,
    expectedInputVersionId:string|null=null,
  ):Promise<string>{
    return this.transaction(scope,async client=>{
      const normalized=normalizeDiscussionInput(content);
      const session=await this.sessionRow(client,scope,sessionId,true);
      const binding=await this.activeBinding(client,scope,true);
      if(expectedInputVersionId!==null&&(!exactUuid(expectedInputVersionId)||session.current_input_version_id!==expectedInputVersionId)){
        reject('conflict','assistant_session_input_conflict');
      }
      let dependencies:string[]=[];
      if(normalized.type==='response_exploration'){
        const message=(await client.query(
          `SELECT message.id FROM message WHERE message.owner_id=$1 AND message.contact_id=$2 AND message.id=$3 AND ${activeMessage}`,
          [scope.owner_id,scope.contact_id,normalized.target_message_id],
        )).rows[0];
        if(!message)reject('conflict','target_message_unavailable');
        dependencies.push(message.id);
        dependencies.push(...(await client.query(`
          SELECT coalesce(ref.source_document_id,ref.observation_id) AS id
            FROM message_source_ref ref
           WHERE ref.owner_id=$1 AND ref.contact_id=$2 AND ref.message_id=$3
             AND (ref.observation_id IS NOT NULL OR EXISTS(
               SELECT 1 FROM source_document source
                WHERE source.id=ref.source_document_id AND source.owner_id=ref.owner_id
                  AND source.contact_id=ref.contact_id AND source.status='active'))`,
        [scope.owner_id,scope.contact_id,message.id])).rows.map(row=>row.id));
      }
      dependencies=[...new Set(dependencies)].sort();
      if(dependencies.length)await this.assistant.verifiedDiscussionDependencies(
        client,scopeOf(scope),dependencies,false,
      );
      const input=(await client.query(`
        INSERT INTO assistant_session_input(
          session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids
        ) VALUES($1,$2,$3,$4,$5,$6,$7)
        RETURNING id`,
      [sessionId,scope.owner_id,scope.contact_id,binding,normalized.type,normalized,dependencies])).rows[0];
      await client.query(
        'UPDATE assistant_session SET current_input_version_id=$4,updated_at=now() WHERE owner_id=$1 AND contact_id=$2 AND id=$3',
        [scope.owner_id,scope.contact_id,sessionId,input.id],
      );
      await recordAssistantUserActivity(client,scope,sessionId,this.options.assistantClock);
      return input.id;
    });
  }

  async editCandidate(
    scope:AssistantDiscussionScope,
    sessionId:string,
    candidateId:string,
    command:AssistantDiscussionEdit,
  ):Promise<Row>{
    if(!command||typeof command!=='object'||!exactUuid(command.edit_key)
      ||!exactUuid(command.parent_version_id))reject('invalid');
    const edited=messages(command.messages);
    const aggregate=edited.map(item=>item.text).join('\n\n');
    if([...aggregate].length>65536
      ||edited.some(item=>[...item.text].length>(edited.length===1?65536:8192))
      ||command.requirements!==undefined&&command.requirements!==null
        &&(!text(command.requirements,4096)||command.requirements!==command.requirements.trim()))reject('invalid');
    return this.transaction(scope,async client=>{
      const result=await this.writeVersion(client,scope,sessionId,candidateId,{
        ...command,
        messages:edited,
        requirements:command.requirements??null,
      });
      return this.history(client,scope,sessionId,result.candidate);
    });
  }

  async editReceipt(
    scope:AssistantDiscussionScope,
    sessionId:string,
    candidateId:string,
    command:AssistantDiscussionEdit,
  ):Promise<Row>{
    const edited=messages(command.messages);
    return this.transaction(scope,async client=>
      (await this.writeVersion(client,scope,sessionId,candidateId,{
        ...command,messages:edited,requirements:command.requirements??null,
      })).receipt,
    );
  }

  private async writeVersion(
    client:Client,
    scope:AssistantDiscussionScope,
    sessionId:string,
    candidateId:string,
    command:AssistantDiscussionEdit&{requirements:string|null},
  ):Promise<{candidate:Row;receipt:Row}>{
    await this.sessionRow(client,scope,sessionId,true);
    const candidate=await this.candidateRow(client,scope,sessionId,candidateId);
    await this.ensureOriginal(client,scope,sessionId,candidate);
    const parent=(await client.query(`
      SELECT 1 FROM assistant_candidate_version
       WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3
         AND candidate_id=$4 AND id=$5`,
    [scope.owner_id,scope.contact_id,sessionId,candidateId,command.parent_version_id])).rows[0];
    if(!parent)reject('not_found');
    const valid=(await client.query(
      'SELECT valid_assistant_candidate_edit_group($1::jsonb,$2::jsonb) AS valid',
      [JSON.stringify(candidate.message_group),JSON.stringify(command.messages)],
    )).rows[0]?.valid;
    if(valid!==true)reject('conflict','message_group_mismatch');
    const existing=(await client.query(`
      SELECT id,version_number,parent_version_id,message_group,requirements
        FROM assistant_candidate_version
       WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3
         AND candidate_id=$4 AND edit_key=$5`,
    [scope.owner_id,scope.contact_id,sessionId,candidateId,command.edit_key])).rows[0];
    if(existing){
      if(existing.parent_version_id!==command.parent_version_id
        ||canonical(existing.message_group)!==canonical(command.messages)
        ||(existing.requirements??null)!==command.requirements)reject('conflict','edit_key_conflict');
      return {candidate,receipt:{
        session_id:sessionId,candidate_id:candidateId,version_id:existing.id,
        version_number:Number(existing.version_number),edit_key:command.edit_key,
        parent_version_id:existing.parent_version_id,
      }};
    }
    const next=Number((await client.query(`
      SELECT coalesce(max(version_number),0)+1 AS number
        FROM assistant_candidate_version
       WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND candidate_id=$4`,
    [scope.owner_id,scope.contact_id,sessionId,candidateId])).rows[0].number);
    const row=(await client.query(`
      INSERT INTO assistant_candidate_version(
        owner_id,contact_id,session_id,turn_id,candidate_id,version_number,
        parent_version_id,edit_key,message_group,requirements
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id,version_number`,
    [scope.owner_id,scope.contact_id,sessionId,candidate.turn_id,candidateId,next,
      command.parent_version_id,command.edit_key,JSON.stringify(command.messages),command.requirements,
    ])).rows[0];
    await recordAssistantUserActivity(client,scope,sessionId,this.options.assistantClock);
    return {candidate,receipt:{
      session_id:sessionId,candidate_id:candidateId,version_id:row.id,
      version_number:Number(row.version_number),edit_key:command.edit_key,
      parent_version_id:command.parent_version_id,
    }};
  }

  async readCandidate(
    scope:AssistantDiscussionScope,
    sessionId:string,
    candidateId:string,
  ):Promise<Row>{
    return this.transaction(scope,async client=>{
      await this.sessionRow(client,scope,sessionId);
      const candidate=await this.candidateRow(client,scope,sessionId,candidateId);
      return this.history(client,scope,sessionId,candidate);
    },true);
  }

  async selectCandidate(
    scope:AssistantDiscussionScope,
    sessionId:string,
    candidateId:string,
    versionId:string,
    selectionKey:string,
  ):Promise<Row>{
    if(![candidateId,versionId,selectionKey].every(exactUuid))reject('invalid');
    return this.transaction(scope,async client=>{
      await this.sessionRow(client,scope,sessionId,true);
      const candidate=await this.candidateRow(client,scope,sessionId,candidateId);
      await this.ensureOriginal(client,scope,sessionId,candidate);
      const version=(await client.query(`
        SELECT 1 FROM assistant_candidate_version
         WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3
           AND candidate_id=$4 AND id=$5`,
      [scope.owner_id,scope.contact_id,sessionId,candidateId,versionId])).rows[0];
      if(!version)reject('not_found');
      const existing=(await client.query(`
        SELECT * FROM assistant_candidate_selection
         WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND selection_key=$4`,
      [scope.owner_id,scope.contact_id,sessionId,selectionKey])).rows[0];
      const publicSelection=(row:Row)=>({
        selection_id:row.id,selection_number:Number(row.selection_number),
        session_id:row.session_id,candidate_id:row.candidate_id,version_id:row.version_id,
      });
      if(existing){
        if(existing.candidate_id!==candidateId||existing.version_id!==versionId)reject('conflict','selection_key_conflict');
        return publicSelection(existing);
      }
      const number=Number((await client.query(`
        SELECT coalesce(max(selection_number),0)+1 AS number
          FROM assistant_candidate_selection
         WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3`,
      [scope.owner_id,scope.contact_id,sessionId])).rows[0].number);
      await client.query(
        'UPDATE assistant_candidate_selection SET is_current=FALSE WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND is_current',
        [scope.owner_id,scope.contact_id,sessionId],
      );
      const row=(await client.query(`
        INSERT INTO assistant_candidate_selection(
          owner_id,contact_id,session_id,selection_key,selection_number,candidate_id,version_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [scope.owner_id,scope.contact_id,sessionId,selectionKey,number,candidateId,versionId])).rows[0];
      return publicSelection(row);
    });
  }

  async selectedCandidate(scope:AssistantDiscussionScope,sessionId:string):Promise<Row|null>{
    return this.transaction(scope,async client=>{
      await this.sessionRow(client,scope,sessionId);
      const row=(await client.query(`
        SELECT * FROM assistant_candidate_selection
         WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND is_current`,
      [scope.owner_id,scope.contact_id,sessionId])).rows[0];
      if(!row)return null;
      await this.candidateRow(client,scope,sessionId,row.candidate_id);
      return {
        selection_id:row.id,selection_number:Number(row.selection_number),
        session_id:row.session_id,candidate_id:row.candidate_id,version_id:row.version_id,
      };
    },true);
  }

  async carryCandidate(
    scope:AssistantDiscussionScope,
    sessionId:string,
    command:AssistantDiscussionSelectionCommand,
  ):Promise<{session_id:string;input_version_id:string}>{
    if(!command||[command.expected_selection_id,command.candidate_id,command.version_id].some(id=>!exactUuid(id)))reject('invalid');
    return this.transaction(scope,async client=>{
      await this.sessionRow(client,scope,sessionId,true);
      const binding=await this.activeBinding(client,scope,true);
      const selected=(await client.query(`
        SELECT * FROM assistant_candidate_selection
         WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND is_current`,
      [scope.owner_id,scope.contact_id,sessionId])).rows[0];
      if(!selected)reject('conflict','candidate_not_selected');
      if(selected.id!==command.expected_selection_id
        ||selected.candidate_id!==command.candidate_id
        ||selected.version_id!==command.version_id)reject('conflict','selection_stale');
      const candidate=await this.candidateRow(client,scope,sessionId,command.candidate_id);
      const history=await this.history(client,scope,sessionId,candidate);
      const version=history.versions.find((item:Row)=>item.version_id===command.version_id);
      if(!version)reject('not_found');
      const deps=[...(await this.assistant.verifiedDiscussionDependencies(
        client,scopeOf(scope),candidate.turn_dependencies,true,
      )),...(await this.ports.requireReplySourcesCurrent(
        client,scopeOf(scope),candidate.reply_request_id,true,
      ))];
      await this.ports.requireSavedSkillPolicy(
        client,scopeOf(scope),candidate.reply_request_id,
      );
      const origin={
        type:'candidate_carry',metadata_version:2,
        origin_owner_id:scope.owner_id,origin_contact_id:scope.contact_id,
        origin_binding_id:binding,origin_session_id:sessionId,
        origin_input_version_id:candidate.input_version_id,origin_turn_id:candidate.turn_id,
        origin_reply_request_id:candidate.reply_request_id,
        origin_candidate_id:candidate.id,origin_version_id:version.version_id,
        origin_selection_id:selected.id,payload_sha256:fingerprint(version.messages),
      };
      await client.query(
        'UPDATE assistant_session SET is_default=FALSE WHERE owner_id=$1 AND contact_id=$2 AND is_default',
        [scope.owner_id,scope.contact_id],
      );
      const created=(await client.query(
        'INSERT INTO assistant_session(owner_id,contact_id,is_default,last_user_activity_at) VALUES($1,$2,TRUE,COALESCE($3::timestamptz,clock_timestamp())) RETURNING id',
        [scope.owner_id,scope.contact_id,await this.options.assistantClock?.()??null],
      )).rows[0].id;
      const input=(await client.query(`
        INSERT INTO assistant_session_input(
          session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids
        ) VALUES($1,$2,$3,$4,'candidate_carry',$5,$6) RETURNING id`,
      [created,scope.owner_id,scope.contact_id,binding,origin,[...new Set(deps)].sort()])).rows[0];
      await client.query(
        'UPDATE assistant_session SET current_input_version_id=$4,updated_at=now() WHERE owner_id=$1 AND contact_id=$2 AND id=$3',
        [scope.owner_id,scope.contact_id,created,input.id],
      );
      return {session_id:created,input_version_id:input.id};
    });
  }

  private async carryContent(
    client:Client,
    scope:AssistantDiscussionScope,
    row:Row,
  ):Promise<Row>{
    const value=row.content;
    if(!value||value.type!=='candidate_carry'||value.metadata_version!==2
      ||value.origin_owner_id!==scope.owner_id||value.origin_contact_id!==scope.contact_id
      ||value.origin_binding_id!==row.conversation_binding_id
      ||value.origin_session_id===row.session_id||!hashPattern.test(value.payload_sha256??''))reject('conflict','candidate_unavailable');
    const candidate=await this.candidateRow(
      client,scope,value.origin_session_id,value.origin_candidate_id,
    );
    if(candidate.turn_id!==value.origin_turn_id
      ||candidate.reply_request_id!==value.origin_reply_request_id
      ||candidate.input_version_id!==value.origin_input_version_id)reject('conflict','candidate_unavailable');
    const history=await this.history(client,scope,value.origin_session_id,candidate);
    const version=history.versions.find((item:Row)=>item.version_id===value.origin_version_id);
    if(!version||fingerprint(version.messages)!==value.payload_sha256)reject('conflict','candidate_unavailable');
    const selected=(await client.query(`
      SELECT 1 FROM assistant_candidate_selection
       WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND id=$4
         AND candidate_id=$5 AND version_id=$6`,
    [scope.owner_id,scope.contact_id,value.origin_session_id,value.origin_selection_id,
      value.origin_candidate_id,value.origin_version_id])).rows[0];
    if(!selected)reject('conflict','candidate_unavailable');
    const deps=await this.assistant.verifiedDiscussionDependencies(
      client,scopeOf(scope),row.dependency_ids??[],true,
    );
    if(canonical([...new Set(deps)].sort())!==canonical([...new Set(row.dependency_ids??[])].sort())){
      reject('conflict','source_unavailable');
    }
    return {...version,content:{...value,messages:version.messages},basis_changes:history.basis_changes??[]};
  }

  async readSession(scope:AssistantDiscussionScope,sessionId:string):Promise<Row>{
    return this.transaction(scope,async client=>{
      const session=await this.sessionRow(client,scope,sessionId);
      let currentBinding:string|null=null;
      try{currentBinding=await this.activeBinding(client,scope,true);}catch{}
      const manualBindings=new Set((await client.query(
        'SELECT id FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 FOR SHARE',
        [scope.owner_id,scope.contact_id],
      )).rows.map(row=>row.id));
      const turnRows=(await client.query(`
        SELECT turn.*,
          (request.id IS NULL AND turn.state='failed' AND EXISTS(
            SELECT 1 FROM reply_invalidated_key sealed
             WHERE sealed.owner_id=turn.owner_id AND sealed.contact_id=turn.contact_id
               AND sealed.idempotency_key=turn.idempotency_key
          )) AS prepared_key_sealed,
          CASE
            WHEN EXISTS(SELECT 1 FROM reply_attempt attempt WHERE attempt.reply_request_id=request.id AND attempt.state='running') THEN TRUE
            WHEN request.state IN ('failed','completed','expired') AND EXISTS(
              SELECT 1 FROM reply_attempt attempt
               WHERE attempt.reply_request_id=request.id AND attempt.number=request.attempt
                 AND attempt.state IN ('failed','completed','expired')
            ) THEN FALSE
            ELSE NULL
          END AS generation_active
          FROM assistant_session_turn turn
          LEFT JOIN reply_request request
            ON request.owner_id=turn.owner_id AND request.contact_id=turn.contact_id
           AND request.idempotency_key=turn.idempotency_key
           AND request.conversation_binding_id=turn.conversation_binding_id
           AND (turn.reply_request_id IS NULL OR request.id=turn.reply_request_id)
         WHERE turn.owner_id=$1 AND turn.contact_id=$2 AND turn.session_id=$3
         ORDER BY turn.created_at,turn.id`,
      [scope.owner_id,scope.contact_id,sessionId])).rows;
      const turns:Row[]=[];
      for(const original of turnRows){
        const row={...original,input_payload:original.input_payload===null?null:structuredClone(original.input_payload)};
        let reply:Row|null=null,basis:Row[]=[];
        if(row.state!=='redacted'){
          try{
            await this.assistant.verifiedDiscussionDependencies(
              client,scopeOf(scope),row.dependency_ids??[],true,
            );
            // 手动确认 ID 与渠道 binding 共用协议槽但来源不同；历史手动 turn
            // 在随后建立渠道 binding 后仍须可读，且不得改写原来源身份。
            if(row.conversation_binding_id!==currentBinding
              &&!manualBindings.has(row.conversation_binding_id))throw new Error('binding');
          }catch{
            row.state='unavailable';row.input_payload=null;
          }
        }
        if(row.state==='completed'){
          const saved=(await client.query(
            "SELECT * FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND state='completed'",
            [scope.owner_id,scope.contact_id,row.reply_request_id],
          )).rows[0];
          try{
            if(!saved)throw new Error('missing');
            await this.ports.requireReplySourcesCurrent(client,scopeOf(scope),saved.id,true);
            await this.ports.requireSavedSkillPolicy(client,scopeOf(scope),saved.id);
            basis=await this.ports.readReplyBasisChanges(client,scopeOf(scope),saved.id);
            const result=await readStoredReplyResult(client,saved);
            reply=replyGeneratedPayload(result,scope.contact_id,basis);
          }catch(error){
            if(error instanceof ReplyStoreError||error instanceof Error)row.state='unavailable';
            else throw error;
            row.input_payload=null;
          }
        }
        turns.push({
          turn_id:row.id,input_version_id:row.input_version_id,
          request_key:row.idempotency_key,state:row.state,
          input:row.input_payload,interruption_reason:row.state==='failed'?row.interruption_reason:null,
          ...(row.generation_active===null||row.generation_active===undefined?{}:{generation_active:row.generation_active}),
          reply,basis_changes:basis,
          placeholder:row.state==='redacted'?'相关来源已删除':row.state==='unavailable'?'相关来源不可用':null,
        });
      }
      const records=await inputRows(client,scope.owner_id,scope.contact_id,sessionId);
      const inputs:Row[]=[];
      for(const record of records){
        let state='active',content:Row|null=record.content,basis:Row[]=[];
        const turn=turns.find(item=>item.turn_id===record.turn_id);
        if(record.state==='redacted'||turn?.state==='redacted')state='redacted';
        else if(record.input_type==='generation'&&!turn)state='unavailable';
        else if(turn?.state==='unavailable')state='unavailable';
        else{
          try{
            if(record.input_type==='candidate_carry'){
              const resolved=await this.carryContent(client,scope,record);
              content=resolved.content;basis=resolved.basis_changes;
            }else{
              const deps=record.input_type==='generation'?record.turn_dependencies:record.dependency_ids;
              await this.assistant.verifiedDiscussionDependencies(
                client,scopeOf(scope),deps??[],record.input_type==='generation',
              );
            }
          }catch{state='unavailable';content=null;basis=[];}
        }
        if(state!=='active')content=null;
        inputs.push({
          input_version_id:record.id,type:record.input_type,
          conversation_binding_id:record.conversation_binding_id,
          turn_id:record.turn_id,state,content,
          ...(basis.length?{basis_changes:basis}:{}),
          placeholder:state==='redacted'?'相关来源已删除':state==='unavailable'?'相关来源不可用':null,
        });
      }
      return {
        session_id:sessionId,current_input_version_id:session.current_input_version_id,
        turns,inputs,
      };
    },true);
  }

  async interrupt(
    scope:AssistantDiscussionScope,
    sessionId:string,
    requestKey:string,
    inputVersionId:string,
    reason:'app_quit'|'configuration_reload'|'user_cancelled'='app_quit',
  ):Promise<Row>{
    if(![sessionId,requestKey,inputVersionId].every(exactUuid)
      ||!['app_quit','configuration_reload','user_cancelled'].includes(reason))reject('invalid');
    return this.transaction(scope,async client=>{
      await this.sessionRow(client,scope,sessionId,true);
      const turn=(await client.query(`
        SELECT * FROM assistant_session_turn
         WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND idempotency_key=$4
         FOR UPDATE`,
      [scope.owner_id,scope.contact_id,sessionId,requestKey])).rows[0];
      if(!turn)reject('not_found');
      if(turn.input_version_id!==inputVersionId)reject('conflict','input_version_stale');
      if(turn.state==='redacted')reject('conflict','source_deleted');
      const input=(await client.query(`
        SELECT state,input_type,conversation_binding_id,dependency_ids
          FROM assistant_session_input
         WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND id=$4`,
      [scope.owner_id,scope.contact_id,sessionId,inputVersionId])).rows[0];
      if(!input||input.input_type!=='generation')reject('conflict','input_version_stale');
      if(input.conversation_binding_id!==turn.conversation_binding_id)reject('conflict','binding_changed');
      try{
        await this.assistant.verifiedDiscussionDependencies(
          client,scopeOf(scope),
          [...new Set([...(input.dependency_ids??[]),...(turn.dependency_ids??[])])],true,
        );
      }catch{reject('conflict','source_unavailable');}
      const request=(await client.query(`
        SELECT * FROM reply_request
         WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 FOR UPDATE`,
      [scope.owner_id,scope.contact_id,requestKey])).rows[0];
      const receipt=(row:Row)=>({
        session_id:row.session_id,turn_id:row.id,request_key:row.idempotency_key,
        input_version_id:row.input_version_id,state:row.state,
        interruption_reason:row.state==='failed'?row.interruption_reason:null,
      });
      if(request?.state==='completed'){
        if(turn.interruption_reason!==null)reject('conflict','generation_interrupted');
        await client.query(
          "UPDATE assistant_session_turn SET state='completed',interruption_reason=NULL,updated_at=now() WHERE id=$1",
          [turn.id],
        );
        return receipt({...turn,state:'completed',interruption_reason:null});
      }
      const invalidated=(await client.query(
        'SELECT 1 FROM reply_invalidated_key WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',
        [scope.owner_id,scope.contact_id,requestKey],
      )).rowCount;
      if(turn.state==='failed'&&turn.interruption_reason===reason&&invalidated)return receipt(turn);
      if(turn.state==='failed'&&turn.interruption_reason!==null)reject('conflict','generation_interrupted');
      if(invalidated&&turn.state!=='failed')reject('conflict','request_deleted');
      await client.query(`
        INSERT INTO reply_invalidated_key(owner_id,contact_id,idempotency_key)
        VALUES($1,$2,$3) ON CONFLICT(owner_id,contact_id,idempotency_key) DO NOTHING`,
      [scope.owner_id,scope.contact_id,requestKey]);
      if(request?.state==='running'){
        await client.query(
          "UPDATE reply_request SET state='failed',lease_expires_at=least(lease_expires_at,now()),updated_at=now() WHERE id=$1",
          [request.id],
        );
        await client.query(
          "UPDATE reply_attempt SET state='failed',failure_reason=$3,lease_expires_at=least(lease_expires_at,now()) WHERE reply_request_id=$1 AND number=$2 AND state='running'",
          [request.id,request.attempt,reason],
        );
      }
      const changed=await client.query(`
        UPDATE assistant_session_turn
           SET state='failed',interruption_reason=$1,updated_at=now()
         WHERE owner_id=$2 AND contact_id=$3 AND session_id=$4 AND id=$5
           AND state IN ('running','failed')`,
      [reason,scope.owner_id,scope.contact_id,sessionId,turn.id]);
      if(changed.rowCount!==1)reject('unavailable');
      return receipt({...turn,state:'failed',interruption_reason:reason});
    });
  }

  async deleteSession(scope:AssistantDiscussionScope,sessionId:string):Promise<{session_id:string;state:'deleted'}>{
    if(!exactUuid(sessionId))reject('invalid');
    const deleted=await this.transaction(scope,async client=>{
      await this.contact(client,scope);
      const session=(await client.query(
        'SELECT id FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3 FOR UPDATE',
        [scope.owner_id,scope.contact_id,sessionId],
      )).rows[0];
      if(!session)return {session_id:sessionId,state:'deleted' as const};
      await this.options.eraseRuntime?.(client,scope,sessionId);
      await eraseManagedUpdateBackups(client,this.options.environment??{});
      await client.query(`
        INSERT INTO reply_invalidated_key(owner_id,contact_id,idempotency_key)
        SELECT owner_id,contact_id,idempotency_key
          FROM assistant_session_turn
         WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3
        ON CONFLICT(owner_id,contact_id,idempotency_key) DO NOTHING`,
      [scope.owner_id,scope.contact_id,sessionId]);
      const requests=(await client.query(`
        WITH RECURSIVE affected(id) AS (
          SELECT request.id
            FROM reply_request request
           WHERE request.owner_id=$1 AND request.contact_id=$2
             AND (
               EXISTS(SELECT 1 FROM assistant_session_turn turn
                       WHERE turn.owner_id=request.owner_id AND turn.contact_id=request.contact_id
                         AND turn.session_id=$3
                         AND (turn.idempotency_key=request.idempotency_key OR turn.reply_request_id=request.id))
               OR request.id IN (
                 SELECT turn.reply_request_id FROM assistant_session_turn turn
                  WHERE turn.owner_id=$1 AND turn.contact_id=$2 AND turn.session_id=$3
                    AND turn.reply_request_id IS NOT NULL
               )
             )
          UNION
          SELECT child.id
            FROM affected
            JOIN reply_candidate candidate ON candidate.reply_request_id=affected.id
            JOIN reply_request child ON child.continued_from_candidate_id=candidate.id
           WHERE candidate.owner_id=$1 AND candidate.contact_id=$2
             AND child.owner_id=$1 AND child.contact_id=$2
        )
        SELECT id,idempotency_key FROM reply_request
         WHERE owner_id=$1 AND contact_id=$2 AND id IN (SELECT id FROM affected)
         FOR UPDATE`,
      [scope.owner_id,scope.contact_id,sessionId])).rows;
      const ids=requests.map(row=>row.id),keys=requests.map(row=>row.idempotency_key);
      const candidates=(await client.query(`
        SELECT id FROM reply_candidate
         WHERE owner_id=$1 AND contact_id=$2 AND reply_request_id=ANY($3::uuid[])`,
      [scope.owner_id,scope.contact_id,ids])).rows.map(row=>row.id);
      const reserved=(await client.query(`
        SELECT id,idempotency_key FROM assistant_session_turn
         WHERE owner_id=$1 AND contact_id=$2
           AND coalesce(input_payload->>'continued_from_candidate_id','')=ANY($3::text[])
         FOR UPDATE`,
      [scope.owner_id,scope.contact_id,candidates])).rows;
      const turns=(await client.query(`
        SELECT id,idempotency_key FROM assistant_session_turn
         WHERE owner_id=$1 AND contact_id=$2
           AND (session_id=$3 OR reply_request_id=ANY($4::uuid[]) OR id=ANY($5::uuid[]))
         FOR UPDATE`,
      [scope.owner_id,scope.contact_id,sessionId,ids,reserved.map(row=>row.id)])).rows;
      const turnIds=[...new Set([...turns,...reserved].map(row=>row.id))];
      const inputs=(await client.query(`
        SELECT id FROM assistant_session_input
         WHERE owner_id=$1 AND contact_id=$2
           AND (session_id=$3 OR turn_id=ANY($4::uuid[]))`,
      [scope.owner_id,scope.contact_id,sessionId,turnIds])).rows.map(row=>row.id);
      await captureAssistantRuntimeDependencies(client,scope.owner_id,turnIds,ids,inputs);
      await eraseSkillLearning(
        client,scope.owner_id,[sessionId,...ids,...candidates,...turnIds,...inputs],
        (connection,input)=>deleteSourceReplies(
          connection,input.ownerId,input.removedIds,input.contactId,input.revokeRunningScope,
        ),
      );
      const protectedKeys=[...new Set([
        ...keys,...turns.map(row=>row.idempotency_key),...reserved.map(row=>row.idempotency_key),
      ])];
      if(protectedKeys.length)await client.query(`
        INSERT INTO reply_invalidated_key(owner_id,contact_id,idempotency_key)
        SELECT $1,$2,unnest($3::uuid[])
        ON CONFLICT(owner_id,contact_id,idempotency_key) DO NOTHING`,
      [scope.owner_id,scope.contact_id,protectedKeys]);
      if(requests.length){
        await client.query(`
          UPDATE reply_attempt SET state='failed',failure_reason='app_quit',
                 lease_expires_at=least(lease_expires_at,now())
           WHERE reply_request_id=ANY($1::uuid[]) AND state='running'`,
        [ids]);
        await client.query("UPDATE reply_request SET state='failed',lease_expires_at=least(lease_expires_at,now()),updated_at=now() WHERE id=ANY($1::uuid[]) AND state='running'",[ids]);
        await client.query('DELETE FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])',[scope.owner_id,scope.contact_id,ids]);
      }
      await client.query(
        'DELETE FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3',
        [scope.owner_id,scope.contact_id,sessionId],
      );
      const remaining=(await client.query(`
        SELECT 1 FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3
        UNION ALL SELECT 1 FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3
        UNION ALL SELECT 1 FROM assistant_session_input WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3`,
      [scope.owner_id,scope.contact_id,sessionId])).rowCount;
      if(remaining)reject('unavailable');
      return {session_id:sessionId,state:'deleted' as const};
    });
    // 业务删除先提交；文件清理由同一 owner 锁重试，不提前擦除仍可能回滚的版本。
    await this.transaction(scope,async client=>{
      await queueUnreferencedPreferenceFiles(client,scope.owner_id,this.files);
      await cleanupSkillFiles(client,scope.owner_id,this.files);
      if((await client.query(
        `SELECT 1 FROM reply_skill_file_cleanup
          WHERE split_part(relative_path,'/',1)=$1
             OR (split_part(relative_path,'/',1) IN ('.versions','.staging')
                 AND split_part(relative_path,'/',2)=$1)
          LIMIT 1`,
        [scope.owner_id],
      )).rowCount)reject('unavailable');
    });
    return deleted;
  }
}
