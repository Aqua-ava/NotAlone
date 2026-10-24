/** 联系人记忆目录：只保存分类、主题提示和记忆 UUID，不复制记忆正文。 */
import type pg from 'pg';
import type {
  ExtractionClaim,
  ExtractionTaskStore,
} from './extraction-task-store.ts';
import type {
  ExtractionWorkerResult,
  ExtractionWorkerRunner,
} from './extraction-worker.ts';

export const MAX_CONTACT_MEMORY_INDEX_TOPICS=20;
export type ContactMemoryCategory='common_fact'|'preference'|'taboo'|'recent_state'|'relationship_note';
export type ContactMemoryTopic='health'|'work'|'family'|'travel'|'finance'|'study'|'emotion'|'other';

export interface ContactMemoryIndexScope {ownerId:string;contactId:string;}
export interface ContactMemoryIndexRef {
  memoryId:string;
  category:ContactMemoryCategory;
  topic:ContactMemoryTopic;
}
export interface ContactMemoryIndexTopic {
  category:ContactMemoryCategory;
  topic:ContactMemoryTopic;
  topic_summary:string;
  memory_ids:string[];
}
export interface ContactMemoryIndexSnapshot {
  builtFromMemoryRevision:bigint;
  currentMemoryRevision:bigint;
  status:'active'|'stale';
  topics:ContactMemoryIndexTopic[];
}
export interface ContactMemoryIndexVerification {
  valid:boolean;
  topicsCount:number;
  errorCode:'index_missing'|'index_not_active'|'index_stale'|'index_reference_invalid'|null;
}
export class ContactMemoryIndexError extends Error {
  readonly code:string;
  readonly retryable:boolean;
  constructor(code:string,retryable=false){
    super(code);this.code=code;this.retryable=retryable;this.name='ContactMemoryIndexError';
  }
}

const categories=new Set<ContactMemoryCategory>([
  'common_fact','preference','taboo','recent_state','relationship_note',
]);
const topics=new Set<ContactMemoryTopic>([
  'health','work','family','travel','finance','study','emotion','other',
]);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;

/** Python 目录合同的确定性排序：主题条目数降序，再按分类和主题升序。 */
export function buildContactMemoryTopics(
  memories:readonly ContactMemoryIndexRef[],
):ContactMemoryIndexTopic[] {
  const groups=new Map<string,{category:ContactMemoryCategory;topic:ContactMemoryTopic;ids:Set<string>}>();
  for(const memory of memories){
    if(!categories.has(memory.category)||!topics.has(memory.topic)){
      throw new Error('contact_memory_index_reference_invalid');
    }
    const key=`${memory.category}:${memory.topic}`;
    const group=groups.get(key)??{category:memory.category,topic:memory.topic,ids:new Set<string>()};
    group.ids.add(memory.memoryId);
    groups.set(key,group);
  }
  return [...groups.values()]
    .sort((left,right)=>right.ids.size-left.ids.size
      ||compareText(left.category,right.category)
      ||compareText(left.topic,right.topic))
    .slice(0,MAX_CONTACT_MEMORY_INDEX_TOPICS)
    .map(group=>({
      category:group.category,
      topic:group.topic,
      topic_summary:`${group.category}:${group.topic}`,
      memory_ids:[...group.ids].sort(),
    }));
}

const validMessageSource=`EXISTS (
  SELECT 1 FROM public.message_source_ref AS ref
  WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id
    AND ref.contact_id=message.contact_id
    AND (
      (ref.source_document_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.source_document AS source
        WHERE source.id=ref.source_document_id AND source.owner_id=ref.owner_id
          AND source.contact_id=ref.contact_id AND source.status='active'
      ))
      OR ref.observation_id IS NOT NULL
    )
)`;

const activeMemoryRefs=`SELECT memory.id,memory.category,memory.topic
  FROM public.confirmed_memory AS memory
  WHERE memory.owner_id=$1 AND memory.contact_id=$2 AND memory.status='active'
    AND (memory.valid_at IS NULL OR memory.valid_at<=now())
    AND (memory.invalid_at IS NULL OR now()<memory.invalid_at)
    AND (
      EXISTS (
        SELECT 1 FROM public.source_document AS source
        WHERE source.owner_id=memory.owner_id AND source.contact_id=memory.contact_id
          AND source.id=ANY(memory.source_ids) AND source.status='active'
      )
      OR EXISTS (
        SELECT 1 FROM public.local_wechat_observation AS observation
        WHERE observation.owner_id=memory.owner_id AND observation.contact_id=memory.contact_id
          AND observation.id=ANY(memory.source_ids)
      )
      OR EXISTS (
        SELECT 1 FROM public.message AS message
        WHERE message.owner_id=memory.owner_id AND message.contact_id=memory.contact_id
          AND message.id=ANY(memory.source_ids) AND ${validMessageSource}
      )
    )
  ORDER BY memory.created_at,memory.id`;

async function ensureState(client:pg.ClientBase,scope:ContactMemoryIndexScope):Promise<void> {
  await client.query(`INSERT INTO public.contact_memory_state(owner_id,contact_id)
    VALUES($1,$2) ON CONFLICT(owner_id,contact_id) DO NOTHING`,[scope.ownerId,scope.contactId]);
}

async function lockRevision(client:pg.ClientBase,scope:ContactMemoryIndexScope):Promise<bigint> {
  const row=(await client.query(`SELECT memory_revision::text AS memory_revision
    FROM public.contact_memory_state
    WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE`,[scope.ownerId,scope.contactId])).rows[0];
  if(!row)throw new Error('contact_memory_index_state_missing');
  return BigInt(row.memory_revision);
}

async function loadMemoryRefs(
  client:pg.ClientBase,scope:ContactMemoryIndexScope,
):Promise<ContactMemoryIndexRef[]> {
  return (await client.query(activeMemoryRefs,[scope.ownerId,scope.contactId])).rows.map(row=>({
    memoryId:row.id,
    category:row.category,
    topic:row.topic,
  }));
}

async function readTopics(
  client:pg.ClientBase,scope:ContactMemoryIndexScope,
):Promise<ContactMemoryIndexSnapshot|null> {
  await ensureState(client,scope);
  const current=await lockRevision(client,scope);
  const row=(await client.query(`SELECT index.built_from_memory_revision::text AS built_from_memory_revision,
    index.status,index.topics
    FROM public.contact_memory_index AS index
    WHERE index.owner_id=$1 AND index.contact_id=$2`,[scope.ownerId,scope.contactId])).rows[0];
  if(!row)return null;
  return {
    builtFromMemoryRevision:BigInt(row.built_from_memory_revision),
    currentMemoryRevision:current,
    status:row.status,
    topics:row.topics,
  };
}

function parseTopics(value:unknown):ContactMemoryIndexTopic[] {
  if(!Array.isArray(value)||value.length>MAX_CONTACT_MEMORY_INDEX_TOPICS){
    throw new Error('contact_memory_index_topics_invalid');
  }
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)){
      throw new Error('contact_memory_index_topics_invalid');
    }
    const topic=item as Record<string,unknown>;
    if(typeof topic.category!=='string'||!categories.has(topic.category as ContactMemoryCategory)
      ||typeof topic.topic!=='string'||!topics.has(topic.topic as ContactMemoryTopic)
      ||typeof topic.topic_summary!=='string'||!topic.topic_summary.trim()
      ||!Array.isArray(topic.memory_ids)||!topic.memory_ids.length
      ||topic.memory_ids.some(id=>typeof id!=='string'||!uuid.test(id))){
      throw new Error('contact_memory_index_topics_invalid');
    }
    return {
      category:topic.category as ContactMemoryCategory,
      topic:topic.topic as ContactMemoryTopic,
      topic_summary:topic.topic_summary,
      memory_ids:[...topic.memory_ids] as string[],
    };
  });
}

function sameTopics(left:readonly ContactMemoryIndexTopic[],right:readonly ContactMemoryIndexTopic[]):boolean {
  return JSON.stringify(left)===JSON.stringify(right);
}

/** 在原任务事务与范围锁内重建目录；任何异常都由调用方事务回滚，旧目录保持可见。 */
export class PostgresContactMemoryIndexRepository {
  async rebuild(client:pg.ClientBase,scope:ContactMemoryIndexScope):Promise<ContactMemoryIndexTopic[]> {
    await ensureState(client,scope);
    const revision=await lockRevision(client,scope);
    let topics:ContactMemoryIndexTopic[];
    try{
      topics=buildContactMemoryTopics(await loadMemoryRefs(client,scope));
    }catch(error){
      throw new ContactMemoryIndexError('index_rebuild_failed');
    }
    await client.query(`INSERT INTO public.contact_memory_index
      (owner_id,contact_id,built_from_memory_revision,status,topics)
      VALUES($1,$2,$3,'active',$4::jsonb)
      ON CONFLICT(owner_id,contact_id) DO UPDATE SET
        built_from_memory_revision=EXCLUDED.built_from_memory_revision,
        status=EXCLUDED.status,topics=EXCLUDED.topics,updated_at=now()`,
    [scope.ownerId,scope.contactId,revision.toString(),JSON.stringify(topics)]);
    const persisted=(await client.query(`SELECT built_from_memory_revision::text AS memory_revision,
      status,topics FROM public.contact_memory_index
      WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE`,[scope.ownerId,scope.contactId])).rows[0];
    let readBack:ContactMemoryIndexTopic[];
    try{readBack=parseTopics(persisted?.topics);}
    catch{throw new ContactMemoryIndexError('index_reference_invalid',true);}
    if(!persisted||persisted.status!=='active'
      ||BigInt(persisted.memory_revision)!==revision
      ||!sameTopics(readBack,topics)){
      throw new ContactMemoryIndexError('index_reference_invalid',true);
    }
    const current=buildContactMemoryTopics(await loadMemoryRefs(client,scope));
    if(!sameTopics(current,topics)){
      throw new ContactMemoryIndexError('index_rebuild_failed',true);
    }
    return topics;
  }

  async read(client:pg.ClientBase,scope:ContactMemoryIndexScope):Promise<ContactMemoryIndexSnapshot|null> {
    return readTopics(client,scope);
  }

  async verify(
    client:pg.ClientBase,scope:ContactMemoryIndexScope,
  ):Promise<ContactMemoryIndexVerification> {
    await ensureState(client,scope);
    const revision=await lockRevision(client,scope);
    const row=(await client.query(`SELECT built_from_memory_revision::text AS built_from_memory_revision,
      status,topics FROM public.contact_memory_index
      WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE`,[scope.ownerId,scope.contactId])).rows[0];
    if(!row)return {valid:false,topicsCount:0,errorCode:'index_missing'};
    let stored:ContactMemoryIndexTopic[];
    try{stored=parseTopics(row.topics);}
    catch{return {valid:false,topicsCount:0,errorCode:'index_reference_invalid'};}
    if(row.status!=='active'){
      return {valid:false,topicsCount:stored.length,errorCode:'index_not_active'};
    }
    if(BigInt(row.built_from_memory_revision)!==revision){
      return {valid:false,topicsCount:stored.length,errorCode:'index_stale'};
    }
    const expected=buildContactMemoryTopics(await loadMemoryRefs(client,scope));
    if(!sameTopics(stored,expected)){
      return {valid:false,topicsCount:stored.length,errorCode:'index_reference_invalid'};
    }
    return {valid:true,topicsCount:stored.length,errorCode:null};
  }
}

export interface ContactMemoryIndexRunnerOptions {
  store:Pick<ExtractionTaskStore,'fenced'>;
  repository?:Pick<PostgresContactMemoryIndexRepository,'rebuild'|'verify'>;
}

function codeOf(error:unknown):string|undefined {
  return error&&typeof error==='object'&&'code' in error
    &&typeof error.code==='string'?error.code:undefined;
}

/** 只借用原任务租约与事务，不领第二条任务、不创建 DSH 状态。 */
export class ContactMemoryIndexRunner implements ExtractionWorkerRunner {
  private readonly store:ContactMemoryIndexRunnerOptions['store'];
  private readonly repository:Pick<PostgresContactMemoryIndexRepository,'rebuild'|'verify'>;
  constructor(options:ContactMemoryIndexRunnerOptions){
    this.store=options.store;
    this.repository=options.repository??new PostgresContactMemoryIndexRepository();
  }

  async run(claim:ExtractionClaim,signal:AbortSignal):Promise<ExtractionWorkerResult> {
    if((claim.stepName!=='index'&&claim.stepName!=='verify')||claim.contactId===null){
      throw new ContactMemoryIndexError('contact_memory_index_claim_invalid');
    }
    signal.throwIfAborted();
    try{
      return await this.store.fenced(claim,async client=>{
        signal.throwIfAborted();
        const scope={ownerId:claim.ownerId,contactId:claim.contactId!};
        if(claim.stepName==='index'){
          const topics=await this.repository.rebuild(client,scope);
          signal.throwIfAborted();
          return {processedCount:topics.length,totalCount:MAX_CONTACT_MEMORY_INDEX_TOPICS};
        }
        const verification=await this.repository.verify(client,scope);
        signal.throwIfAborted();
        if(!verification.valid){
          throw new ContactMemoryIndexError(
            verification.errorCode??'index_reference_invalid',true,
          );
        }
        return {
          processedCount:verification.topicsCount,
          totalCount:MAX_CONTACT_MEMORY_INDEX_TOPICS,
        };
      });
    }catch(error){
      if(signal.aborted||codeOf(error)==='lease_stale'
        ||error instanceof ContactMemoryIndexError)throw error;
      throw new ContactMemoryIndexError(
        claim.stepName==='index'?'index_rebuild_failed':'index_verification_failed',
        true,
      );
    }
  }
}
