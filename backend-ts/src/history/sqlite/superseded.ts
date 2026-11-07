import type {SQLInputValue} from 'node:sqlite';
import type {StorageTransaction} from '../../storage/sqlite/contracts.ts';

/**
 * 被取代绑定的副本识别与引用判定（ADR-175）。
 *
 * 只读：这里不写任何行。写入由统一删除框架的 `superseded_history` 范围完成，
 * 本模块负责回答三个问题：哪些绑定已被取代、哪些消息仍被派生结果引用、哪些消息可清。
 */
export type SupersededReader=Pick<StorageTransaction,'all'|'get'>;

/**
 * 派生结果对来源的引用登记表。表内任何一行引用某条消息或其来源记录，该消息就必须保留。
 * 新增引用 `message`／`capture_record` 的表必须在此登记（或登记为被清理对象），
 * `superseded-references.test.mjs` 用 PRAGMA 枚举全库校验，漏登记会使测试失败。
 */
export const retainingReferences:readonly {table:string;contactColumn:string;recordColumn?:string;messageColumn?:string}[]=[
 {table:'reply_context_item',contactColumn:'source_contact_id',recordColumn:'record_id',messageColumn:'message_id'},
 {table:'run_input',contactColumn:'source_contact_id',recordColumn:'record_id',messageColumn:'message_id'},
 {table:'event_source',contactColumn:'source_contact_id',recordColumn:'record_id'},
 {table:'reply_candidate_input_source',contactColumn:'source_contact_id',recordColumn:'record_id',messageColumn:'message_id'},
 {table:'step_input',contactColumn:'source_contact_id',recordColumn:'record_id',messageColumn:'message_id'},
 {table:'memory_citation',contactColumn:'source_contact_id',recordColumn:'record_id',messageColumn:'message_id'},
 {table:'memory_required_message',contactColumn:'source_contact_id',messageColumn:'message_id'},
 {table:'processing_item',contactColumn:'contact_id',messageColumn:'message_id'},
];
/**
 * 随消息一并清理（或由其他登记保护）的表：它们引用消息或来源记录，但只是该消息自己的附属资料。
 * `message` 与 `capture_record` 本身不在此列。
 */
export const ownedReferences:readonly string[]=[
 'message_alias','message_media','media_extraction_attempt','media_file','history_quote','history_quote_attempt','history_message_quarantine',
];

const MAX_CLEAR_IDS=100000;
const str=(value:unknown)=>String(value);

export type SupersededGateReason='contact_inactive'|'continuity_fence'|'deletion_fence'|'recertify_running'|'deletion_pending'|'no_certified_current'|'current_empty';
export interface SupersededBinding {bindingId:string;conversationId:string;currentBindingId:string}

/**
 * 被取代绑定：已撤销，曾被修复同步显式替换，且同一会话现在有已通过修复认证的验证绑定。
 * 单纯被用户撤销读取而未经修复替换的绑定不在此列。
 */
export function supersededBindings(db:SupersededReader,ownerId:string,contactId:string):SupersededBinding[] {
 return db.all(`SELECT b.id binding_id,b.conversation_id,min(cur.id) current_binding_id FROM conversation_binding b
  JOIN conversation_binding cur ON cur.owner_id=b.owner_id AND cur.contact_id=b.contact_id AND cur.conversation_id=b.conversation_id AND cur.state='verified' AND cur.id<>b.id
  WHERE b.owner_id=? AND b.contact_id=? AND b.state='revoked'
   AND EXISTS(SELECT 1 FROM history_source_recertification r WHERE r.owner_id=b.owner_id AND r.contact_id=b.contact_id AND r.old_binding_id=b.id AND r.new_binding_id IS NOT NULL)
   AND EXISTS(SELECT 1 FROM history_source_recertification d WHERE d.owner_id=cur.owner_id AND d.contact_id=cur.contact_id AND d.new_binding_id=cur.id AND d.state='completed')
  GROUP BY b.id,b.conversation_id ORDER BY b.id`,[ownerId,contactId])
  .map(row=>({bindingId:str(row.binding_id),conversationId:str(row.conversation_id),currentBindingId:str(row.current_binding_id)}));
}

/** 联系人当前能否清理：没有围栏、没有进行中的修复或其他删除，且现行副本非空。返回 undefined 表示可清理。 */
export function supersededGate(db:SupersededReader,ownerId:string,contactId:string,bindings?:SupersededBinding[]):SupersededGateReason|undefined {
 if(!db.get("SELECT 1 FROM contact c JOIN owner o ON o.owner_id=c.owner_id WHERE c.owner_id=? AND c.id=? AND c.state='active' AND o.state='active'",[ownerId,contactId]))return 'contact_inactive';
 if(db.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[ownerId,contactId]))return 'continuity_fence';
 if(db.get('SELECT 1 FROM history_deletion_fence WHERE owner_id=? AND contact_id=?',[ownerId,contactId]))return 'deletion_fence';
 if(db.get("SELECT 1 FROM history_source_recertification WHERE owner_id=? AND contact_id=? AND state='running'",[ownerId,contactId]))return 'recertify_running';
 if(db.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed' AND scope_kind<>'superseded_history' AND (scope_kind='account' OR contact_identity=?)",[ownerId,contactId]))return 'deletion_pending';
 const list=bindings??supersededBindings(db,ownerId,contactId);
 if(!list.length)return 'no_certified_current';
 for(const current of new Set(list.map(b=>b.currentBindingId)))
  if(!db.get("SELECT 1 FROM message WHERE owner_id=? AND contact_id=? AND binding_id=? AND availability='available' LIMIT 1",[ownerId,contactId,current]))return 'current_empty';
 return undefined;
}

const union=(parts:string[])=>parts.join('\n  UNION ');
/** 被引用的来源记录与消息：每张登记表扫描一次，规模取决于派生结果而非聊天历史。 */
function referenceCtes(ownerId:string,contactId:string):{sql:string;params:SQLInputValue[]} {
 const records=retainingReferences.filter(r=>r.recordColumn),messages=retainingReferences.filter(r=>r.messageColumn);
 const params:SQLInputValue[]=[];
 const select=(column:string)=>(r:typeof retainingReferences[number])=>{params.push(ownerId,contactId);return `SELECT ${column==='record'?r.recordColumn:r.messageColumn} AS id FROM ${r.table} WHERE owner_id=? AND ${r.contactColumn}=? AND ${column==='record'?r.recordColumn:r.messageColumn} IS NOT NULL`;};
 const recordParts=records.map(select('record')),messageParts=messages.map(select('message'));
 return {sql:`ref_records AS MATERIALIZED (\n  ${union(recordParts)}\n), ref_messages AS MATERIALIZED (\n  ${union(messageParts)}\n)`,params};
}

/** 仅按直接引用判定、再沿保留消息的引用关系闭包：被保留消息引用的目标消息也必须保留。 */
export function retainedMessageIds(db:SupersededReader,ownerId:string,contactId:string,bindingIds:readonly string[]):Set<string> {
 if(!bindingIds.length)return new Set();
 const cte=referenceCtes(ownerId,contactId);
 const rows=db.all(`WITH ${cte.sql}
  SELECT m.id FROM message m WHERE m.owner_id=? AND m.contact_id=? AND m.binding_id IN (SELECT value FROM json_each(?)) AND (
   m.id IN (SELECT id FROM ref_messages)
   OR m.id IN (SELECT r.message_id FROM capture_record r WHERE r.owner_id=? AND r.contact_id=? AND r.message_id IS NOT NULL AND r.id IN (SELECT id FROM ref_records))
   OR EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id))`,
  [...cte.params,ownerId,contactId,JSON.stringify(bindingIds),ownerId,contactId]);
 const retained=new Set(rows.map(row=>str(row.id)));
 closeOverQuotes(db,ownerId,contactId,retained);
 return retained;
}
/** history_quote 的 target_message_id 是对目标的外键依赖；被保留的引用者必须带着目标一起保留。 */
function closeOverQuotes(db:SupersededReader,ownerId:string,contactId:string,retained:Set<string>):void {
 let frontier=[...retained];
 while(frontier.length){
  const next:string[]=[];
  for(let i=0;i<frontier.length;i+=500){
   for(const row of db.all(`SELECT target_message_id FROM history_quote WHERE owner_id=? AND contact_id=? AND target_message_id IS NOT NULL AND message_id IN (SELECT value FROM json_each(?))`,[ownerId,contactId,JSON.stringify(frontier.slice(i,i+500))])){
    const target=str(row.target_message_id);if(!retained.has(target)){retained.add(target);next.push(target);}
   }
  }
  frontier=next;
 }
}

export interface ClearableMessage {id:string;displayNo:bigint;bindingId:string}
export interface ClearableOptions {maxDisplayNo?:bigint;limit?:number;ids?:readonly string[]}
/** 被取代绑定下没有任何派生引用的消息，按 display_no 升序。 */
export function clearableMessages(db:SupersededReader,ownerId:string,contactId:string,bindingIds:readonly string[],options:ClearableOptions={}):ClearableMessage[] {
 if(!bindingIds.length)return [];
 if(options.ids&&options.ids.length>MAX_CLEAR_IDS)throw new RangeError('superseded_ids_too_many');
 const retained=[...retainedMessageIds(db,ownerId,contactId,bindingIds)];
 const params:SQLInputValue[]=[ownerId,contactId,JSON.stringify(bindingIds),JSON.stringify(retained)];
 let where='';
 if(options.maxDisplayNo!==undefined){where+=' AND m.display_no<=?';params.push(options.maxDisplayNo);}
 if(options.ids){where+=' AND m.id IN (SELECT value FROM json_each(?))';params.push(JSON.stringify(options.ids));}
 const limit=options.limit!==undefined?' LIMIT ?':'';if(options.limit!==undefined)params.push(options.limit);
 return db.all(`SELECT m.id,m.display_no,m.binding_id FROM message m WHERE m.owner_id=? AND m.contact_id=?
  AND m.binding_id IN (SELECT value FROM json_each(?)) AND m.availability='available'
  AND m.id NOT IN (SELECT value FROM json_each(?))${where}
  AND NOT EXISTS(SELECT 1 FROM capture_record r INDEXED BY capture_record_message WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND r.availability<>'available')
  ORDER BY m.display_no${limit}`,params)
  .map(row=>({id:str(row.id),displayNo:BigInt(row.display_no as bigint|number),bindingId:str(row.binding_id)}));
}

/** 单条消息的保留判定：用索引探测代替整联系人扫描，供逐条清理时在写事务内复验。 */
export function messageRetained(db:SupersededReader,ownerId:string,contactId:string,messageId:string,seen:Set<string>=new Set()):boolean {
 if(seen.has(messageId))return false;seen.add(messageId);
 if(db.get('SELECT 1 FROM history_message_quarantine WHERE owner_id=? AND contact_id=? AND message_id=? LIMIT 1',[ownerId,contactId,messageId]))return true;
 for(const ref of retainingReferences){
  if(ref.messageColumn&&db.get(`SELECT 1 FROM ${ref.table} WHERE owner_id=? AND ${ref.contactColumn}=? AND ${ref.messageColumn}=? LIMIT 1`,[ownerId,contactId,messageId]))return true;
  if(ref.recordColumn&&db.get(`SELECT 1 FROM capture_record r INDEXED BY capture_record_message WHERE r.owner_id=? AND r.contact_id=? AND r.message_id=? AND EXISTS(SELECT 1 FROM ${ref.table} x WHERE x.owner_id=r.owner_id AND x.${ref.contactColumn}=r.contact_id AND x.${ref.recordColumn}=r.id) LIMIT 1`,[ownerId,contactId,messageId]))return true;
 }
 // 目标消息随引用者保留：只要有一条引用它的 quote 的载体被保留，就不能清。
 for(const quote of db.all('SELECT message_id FROM history_quote WHERE owner_id=? AND contact_id=? AND target_message_id=?',[ownerId,contactId,messageId]))
  if(messageRetained(db,ownerId,contactId,str(quote.message_id),seen))return true;
 return false;
}

/** 当前这条消息是否仍属于被取代绑定的可清集合（写事务内逐条复验用）。 */
export function messageStillClearable(db:SupersededReader,ownerId:string,contactId:string,messageId:string):boolean {
 const row=db.get("SELECT binding_id,availability FROM message WHERE owner_id=? AND contact_id=? AND id=?",[ownerId,contactId,messageId]);
 if(!row||row.availability!=='available')return false;
 const bindings=supersededBindings(db,ownerId,contactId);
 if(!bindings.some(b=>b.bindingId===row.binding_id))return false;
 if(supersededGate(db,ownerId,contactId,bindings))return false;
 if(db.get("SELECT 1 FROM capture_record INDEXED BY capture_record_message WHERE owner_id=? AND contact_id=? AND message_id=? AND availability<>'available' LIMIT 1",[ownerId,contactId,messageId]))return false;
 return !messageRetained(db,ownerId,contactId,messageId);
}

/**
 * 一批可清消息的上界：取第 N 条可清消息的 display_no。批次由 accepted_generation 固定，
 * 同一操作的重新收集永远只落在同一范围内，使有界批次能够结案而不是滚动。
 */
export function batchBoundary(db:SupersededReader,ownerId:string,contactId:string,batchSize:number):{boundary:bigint;size:number}|undefined {
 const bindings=supersededBindings(db,ownerId,contactId);
 if(!bindings.length)return;
 const rows=clearableMessages(db,ownerId,contactId,bindings.map(b=>b.bindingId),{limit:batchSize});
 if(!rows.length)return;
 return {boundary:rows[rows.length-1]!.displayNo,size:rows.length};
}

/** 本批在写入前需要清理的对象：消息束及随后因记录清空而可删的抓取页。 */
export interface SupersededBatch {messages:ClearableMessage[];captureIds:string[]}
export function batchTargets(db:SupersededReader,ownerId:string,contactId:string,boundary:bigint):SupersededBatch {
 const bindings=supersededBindings(db,ownerId,contactId);
 if(!bindings.length||supersededGate(db,ownerId,contactId,bindings))return {messages:[],captureIds:[]};
 const bindingIds=bindings.map(b=>b.bindingId);
 const messages=clearableMessages(db,ownerId,contactId,bindingIds,{maxDisplayNo:boundary});
 const ids=messages.map(m=>m.id);
 // 抓取页仅在其下全部记录都属于本批消息（或已无记录）时一并清理；保留消息与非规范记录继续占住它。
 const captures=db.all(`SELECT c.id FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
  WHERE c.owner_id=? AND c.contact_id=? AND g.binding_id IN (SELECT value FROM json_each(?))
   AND NOT EXISTS(SELECT 1 FROM capture_record r INDEXED BY capture_record_capture WHERE r.owner_id=c.owner_id AND r.contact_id=c.contact_id AND r.capture_id=c.id
    AND (r.message_id IS NULL OR r.message_id NOT IN (SELECT value FROM json_each(?))))
  ORDER BY c.id`,[ownerId,contactId,JSON.stringify(bindingIds),JSON.stringify(ids)]);
 return {messages,captureIds:captures.map(row=>str(row.id))};
}

export interface SupersededCounts {
 bindings:number;clearableMessages:number;retainedMessages:number;clearableRecords:number;emptyCaptures:number;
 mediaFiles:number;mediaBytes:number;
}
/** 预览与存量清单共用：不分批、不写入，按同一规则统计可清和保留的对象。 */
export function supersededCounts(db:SupersededReader,ownerId:string,contactId:string,bindings:SupersededBinding[]=supersededBindings(db,ownerId,contactId)):SupersededCounts {
 const bindingIds=bindings.map(b=>b.bindingId);
 const empty:SupersededCounts={bindings:bindings.length,clearableMessages:0,retainedMessages:0,clearableRecords:0,emptyCaptures:0,mediaFiles:0,mediaBytes:0};
 if(!bindingIds.length)return empty;
 const total=Number(db.get("SELECT count(*) n FROM message WHERE owner_id=? AND contact_id=? AND binding_id IN (SELECT value FROM json_each(?)) AND availability='available'",[ownerId,contactId,JSON.stringify(bindingIds)])!.n);
 const rows=clearableMessages(db,ownerId,contactId,bindingIds);
 const ids=JSON.stringify(rows.map(row=>row.id));
 const records=Number(db.get('SELECT count(*) n FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id IN (SELECT value FROM json_each(?))',[ownerId,contactId,ids])!.n);
 const media=db.get(`SELECT count(*) n,coalesce(sum(byte_size),0) bytes FROM media_file WHERE owner_id=? AND contact_id=? AND content_state='present' AND message_id IN (SELECT value FROM json_each(?))`,[ownerId,contactId,ids])!;
 const captures=Number(db.get(`SELECT count(*) n FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
  WHERE c.owner_id=? AND c.contact_id=? AND g.binding_id IN (SELECT value FROM json_each(?))
   AND NOT EXISTS(SELECT 1 FROM capture_record r INDEXED BY capture_record_capture WHERE r.owner_id=c.owner_id AND r.contact_id=c.contact_id AND r.capture_id=c.id
    AND (r.message_id IS NULL OR r.message_id NOT IN (SELECT value FROM json_each(?))))`,[ownerId,contactId,JSON.stringify(bindingIds),ids])!.n);
 return {bindings:bindings.length,clearableMessages:rows.length,retainedMessages:total-rows.length,clearableRecords:records,emptyCaptures:captures,mediaFiles:Number(media.n),mediaBytes:Number(media.bytes)};
}

/** 各类引用各自保留了多少条被取代绑定下的消息（同一条消息可被多类引用，故合计可大于保留数）。 */
export function retentionBreakdown(db:SupersededReader,ownerId:string,contactId:string,bindingIds:readonly string[]):Record<string,number> {
 const result:Record<string,number>={};
 if(!bindingIds.length)return result;
 const bindings=JSON.stringify(bindingIds);
 for(const ref of retainingReferences){
  const parts:string[]=[],params:SQLInputValue[]=[ownerId,contactId,bindings];
  if(ref.messageColumn){parts.push(`m.id IN (SELECT ${ref.messageColumn} FROM ${ref.table} WHERE owner_id=? AND ${ref.contactColumn}=? AND ${ref.messageColumn} IS NOT NULL)`);params.push(ownerId,contactId);}
  if(ref.recordColumn){parts.push(`m.id IN (SELECT r.message_id FROM capture_record r WHERE r.owner_id=? AND r.contact_id=? AND r.message_id IS NOT NULL AND r.id IN (SELECT ${ref.recordColumn} FROM ${ref.table} WHERE owner_id=? AND ${ref.contactColumn}=? AND ${ref.recordColumn} IS NOT NULL))`);params.push(ownerId,contactId,ownerId,contactId);}
  const count=Number(db.get(`SELECT count(*) n FROM message m WHERE m.owner_id=? AND m.contact_id=? AND m.binding_id IN (SELECT value FROM json_each(?)) AND m.availability='available' AND (${parts.join(' OR ')})`,params)!.n);
  if(count)result[ref.table]=count;
 }
 const quarantined=Number(db.get('SELECT count(*) n FROM history_message_quarantine q JOIN message m ON m.owner_id=q.owner_id AND m.contact_id=q.contact_id AND m.id=q.message_id WHERE q.owner_id=? AND q.contact_id=? AND m.binding_id IN (SELECT value FROM json_each(?))',[ownerId,contactId,bindings])!.n);
 if(quarantined)result.history_message_quarantine=quarantined;
 return result;
}

export function pendingWork(counts:SupersededCounts):boolean {return counts.clearableMessages>0;}
