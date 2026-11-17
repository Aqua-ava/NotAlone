import {REPLY_DOCUMENT_BUDGET} from '../../../reply/sqlite/candidates/knowledge-budget.ts';
import {StorageFailure,type StorageRow,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionScope} from '../../../reply/sqlite/contracts.ts';
import type {ReplyKnowledgeItem,ReplyKnowledgeReader,ReplyMemoryReader,ReplyKnowledgeValidation} from '../../../reply/sqlite/candidates/contracts.ts';
import {available} from '../management/qualification.ts';
import {memoryKnowledgeReader,createMemoryKnowledgeReader} from '../management/knowledge.ts';
import {assertSourceEligibility,type SourceEligibility} from '../../../history/sqlite/source.ts';
import {assertReplyLocalSource} from '../../../history/sqlite/reply-local-source.ts';
import {documentSources,publicationMembers,withSourceMemo} from './basis.ts';
import type {ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';

/** 发布修订随实际输入冻结；在途只复验原集合，后来新增资料留给下一次请求。 */
export interface DocumentKnowledgeItem extends ReplyKnowledgeItem {documentRevision:bigint}
export interface DocumentKnowledgeReader extends ReplyKnowledgeValidation {
 read(tx:StorageTransaction,scope:DiscussionScope):ReplyKnowledgeItem[];
 readDocument:NonNullable<ReplyKnowledgeReader['readDocument']>;
}

const sections:Record<string,string>={basic_information:'基本资料',long_term_preferences:'长期偏好',life_context:'生活背景',interests:'兴趣',insights:'观察与推断',evolution:'变化',contradictions:'待厘清的矛盾'};
const kinds:Record<string,string>={fact:'事实',preference:'明确偏好',inference:'推断',contradiction:'矛盾'};
const temporal:Record<string,string>={stable:'长期',historical:'历史',uncertain:'不确定'};
function statement(row:StorageRow):string {
 const parts:string[]=[];
 if(row.section)parts.push(`【${sections[String(row.section)]??String(row.section)}】`);
 if(row.profile_kind)parts.push(`${kinds[String(row.profile_kind)]??String(row.profile_kind)}：`);
 else if(row.kind==='inference')parts.push('推断：');
 else if(row.kind==='contradiction')parts.push('矛盾：');
 parts.push(String(row.body));
 if(row.temporal_status)parts.push(`（${temporal[String(row.temporal_status)]??String(row.temporal_status)}）`);
 if(row.rationale)parts.push(`依据：${String(row.rationale)}。`);
 if(row.uncertainty)parts.push(`不确定性：${String(row.uncertainty)}。`);
 if(row.kind==='contradiction'){
  parts.push(`两侧资料：${String(row.left_claim)} / ${String(row.right_claim)}。`);
  parts.push(row.resolution_state==='resolved'?`处理结果：${String(row.resolution_text)}。`:'状态：尚未厘清。');
 }
 return parts.join('');
}
function textOf(tx:StorageTransaction,ownerId:string,member:StorageRow):string {
 const rows=tx.all(`SELECT s.*,b.heading FROM document_statement s JOIN document_block b ON b.owner_id=s.owner_id AND b.document_id=s.document_id AND b.version_no=s.version_no AND b.block_no=s.block_no
  WHERE s.owner_id=? AND s.document_id=? AND s.version_no=? ORDER BY s.block_no,s.statement_no`,[ownerId,member.document_id,member.version_no]);
 if(!rows.length)throw new StorageFailure('document_basis_missing');
 const lines=[`${member.kind==='scene'?'【主题资料】':'【长期背景】'}${String(member.title)}`];
 let lastHeading:string|null=null;
 for(const row of rows){
  const heading=row.heading===null?null:String(row.heading);
  // 画像分区已由结构化 section 呈现，避免将内部字段名暴露为自然语言。
  if(member.kind==='scene'&&heading&&heading!==lastHeading)lines.push(heading);
  lines.push(statement(row));lastHeading=heading;
 }
 return lines.join('\n');
}
function projected(tx:StorageTransaction,ownerId:string,member:StorageRow,previous?:ReplyKnowledgeItem):Pick<ReplyKnowledgeItem,'text'|'projection'>|null {
 if(previous&&!previous.projection)return {text:textOf(tx,ownerId,member)};
 if(member.kind==='scene'&&previous?.projection?.kind!=='blocks'){
  const blockCount=Number(tx.get('SELECT count(*) n FROM document_block WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,member.document_id,member.version_no])!.n);
  return {projection:{kind:'directory',blockCount},text:`【主题目录】${String(member.title)}\n提示：${String(member.hint??'')}\n段落数：${blockCount}；正文须用本材料编号调用read_relationship_document。`};
 }
 if(previous?.projection?.kind==='directory')throw new StorageFailure('document_knowledge_stale');
 const range=previous?.projection?.kind==='blocks'?previous.projection:null;
 if(range&&(member.kind!=='scene'||!Number.isSafeInteger(range.startBlock)||range.startBlock<1||!Number.isSafeInteger(range.blockCount)||range.blockCount<1||range.blockCount>REPLY_DOCUMENT_BUDGET.documentBlocks))throw new StorageFailure('reply_document_range_invalid');
 const rows=tx.all(`SELECT s.*,b.heading FROM document_statement s JOIN document_block b ON b.owner_id=s.owner_id AND b.document_id=s.document_id AND b.version_no=s.version_no AND b.block_no=s.block_no
  WHERE s.owner_id=? AND s.document_id=? AND s.version_no=?${range?' AND s.block_no>=? AND s.block_no<?':''} ORDER BY s.block_no,s.statement_no${range?'':' LIMIT ?'}`,
  [ownerId,member.document_id,member.version_no,...(range?[range.startBlock,range.startBlock+range.blockCount]:[REPLY_DOCUMENT_BUDGET.profileCount])]);
 if(range){
  if(new Set(rows.map(row=>String(row.block_no))).size!==range.blockCount)throw new StorageFailure('reply_document_range_invalid');
  const text=[`【主题资料】${String(member.title)}`,...rows.map(statement)].join('\n');
  if(Array.from(text).length>REPLY_DOCUMENT_BUDGET.documentChars)throw new StorageFailure('reply_document_budget_exceeded');
  return {text,projection:{kind:'blocks',startBlock:range.startBlock,blockCount:range.blockCount}};
 }
 const lines=[`【长期背景】${String(member.title)}`],statementNos:number[]=[];
 let chars=Array.from(lines[0]!).length;
 for(const [index,row] of rows.entries()){
  const text=statement(row),size=Array.from(text).length+1;
  if(chars+size>REPLY_DOCUMENT_BUDGET.profileChars)continue;
  lines.push(text);chars+=size;statementNos.push(index+1);
 }
 return statementNos.length?{text:lines.join('\n'),projection:{kind:'profile',statementNos}}:null;
}
function scopeItems(tx:StorageTransaction,scope:DiscussionScope,scopeKind:'self'|'contact',sourceEligibility:SourceEligibility,selected?:readonly ReplyKnowledgeItem[],publicationIdOverride?:string):DocumentKnowledgeItem[]{
 const ownerId=scope.ownerId,contactId=scopeKind==='self'?null:scope.contactId;
 const current=scopeKind==='self'?tx.get('SELECT current_publication_id,document_revision FROM owner WHERE owner_id=?',[ownerId]):tx.get('SELECT current_publication_id,document_revision FROM contact WHERE owner_id=? AND id=?',[ownerId,contactId]);
 if(!current||current.current_publication_id===null&&!publicationIdOverride)return [];
 try{
  // 本闭包只读；同一发布集合共享的记忆来源复用，不延续到后续写入或下一次读取。
  return withSourceMemo(()=>{
  const cache=new Map<string,ReplySource[]>(),publicationId=publicationIdOverride??String(current.current_publication_id),members=publicationMembers(tx,ownerId,publicationId,scopeKind,contactId,cache,sourceEligibility);
  // 完整集合只在本次调用内复核一次；同文档的目录与正文仍各自重建并比较。
  const requested=new Map<string,ReplyKnowledgeItem[]>();
  for(const item of selected??[])requested.set(item.id,[...(requested.get(item.id)??[]),item]);
  return members.flatMap(member=>{
   const projections=selected?requested.get(String(member.document_id))??[]:[undefined];if(!projections.length)return [];
   const sources=documentSources(tx,ownerId,String(member.document_id),member.version_no as bigint,new Set(),cache,sourceEligibility);
   if(scopeKind==='contact'&&sources.some(source=>source.contactId!==contactId))throw new StorageFailure('document_scope_stale');
   return projections.flatMap(previous=>{
    const projection=projected(tx,ownerId,member,previous);if(!projection)return [];
    return [{kind:'document' as const,id:String(member.document_id),versionNo:member.version_no as bigint,scopeKind:scopeKind==='self'?'owner' as const:'contact' as const,contactId,publicationId,
     ...projection,qualification:'published' as const,sources,documentRevision:current.document_revision as bigint}];
   });
  });
  },tx,sourceEligibility);
 }catch(error){
  // 来源失效时省略整个发布集合；精确复核随后因缺少原项而拒绝，工具范围／预算仍显式返回。
  if(error instanceof StorageFailure&&!['reply_document_range_invalid','reply_document_budget_exceeded'].includes(error.code))return [];
  throw error;
 }
}
function items(tx:StorageTransaction,scope:DiscussionScope,sourceEligibility:SourceEligibility):DocumentKnowledgeItem[]{
 available(tx,scope.ownerId,{scopeKind:'contact',contactId:scope.contactId});
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[scope.ownerId]))return [];
 return [...scopeItems(tx,scope,'self',sourceEligibility),...scopeItems(tx,scope,'contact',sourceEligibility)];
}
function serialized(value:unknown):string{return JSON.stringify(value,(_key,v)=>typeof v==='bigint'?v.toString():v);}
function requireDocuments(tx:StorageTransaction,scope:DiscussionScope,expected:readonly ReplyKnowledgeItem[],sourceEligibility:SourceEligibility,frozen=false):void{
 if(!expected.length)return;
 available(tx,scope.ownerId,{scopeKind:'contact',contactId:scope.contactId});
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[scope.ownerId]))throw new StorageFailure('document_knowledge_stale');
 const key=(item:ReplyKnowledgeItem)=>serialized([item.id,item.projection]),groups=new Map<string,ReplyKnowledgeItem[]>();
 for(const item of expected){
  if(item.kind!=='document'||!['owner','contact'].includes(item.scopeKind)||typeof item.publicationId!=='string'||!item.publicationId)throw new StorageFailure('document_knowledge_stale');
  const group=serialized([item.scopeKind,frozen?item.publicationId:null]);groups.set(group,[...(groups.get(group)??[]),item]);
 }
 for(const selected of groups.values()){
  const first=selected[0]!,scopeKind=first.scopeKind;
  const current=new Map(scopeItems(tx,scope,scopeKind==='owner'?'self':'contact',sourceEligibility,selected,frozen?first.publicationId!:undefined).map(item=>[key(item),item]));
  for(const item of selected){
   const found=current.get(key(item)),previous=item as DocumentKnowledgeItem;
   if(!found||found.scopeKind!==item.scopeKind||found.contactId!==item.contactId||found.versionNo!==item.versionNo||found.publicationId!==item.publicationId||!frozen&&found.documentRevision!==previous.documentRevision
    ||serialized(found.projection)!==serialized(item.projection)||found.qualification!==item.qualification||found.text!==item.text||serialized(found.sources)!==serialized(item.sources))throw new StorageFailure('document_knowledge_stale');
  }
 }
}
export function createDocumentKnowledgeReader(sourceEligibility:SourceEligibility=assertSourceEligibility):DocumentKnowledgeReader {
 return {
  read:(tx,scope)=>items(tx,scope,sourceEligibility),
  readDocument(tx,scope,item,range){
   if(item.projection?.kind!=='directory'||!Number.isSafeInteger(range.startBlock)||range.startBlock<1||!Number.isSafeInteger(range.blockCount)||range.blockCount<1||range.blockCount>REPLY_DOCUMENT_BUDGET.documentBlocks||range.startBlock+range.blockCount-1>item.projection.blockCount)throw new StorageFailure('reply_document_range_invalid');
   requireDocuments(tx,scope,[item],sourceEligibility,true);
   const found=scopeItems(tx,scope,item.scopeKind==='owner'?'self':'contact',sourceEligibility,[{...item,projection:{kind:'blocks',...range}}],item.publicationId!)[0];
   if(!found)throw new StorageFailure('document_knowledge_stale');
   return {...found,documentRevision:(item as DocumentKnowledgeItem).documentRevision};
  },
  requireCurrent:(tx,scope,item)=>requireDocuments(tx,scope,[item],sourceEligibility),
  requireFrozen:(tx,scope,item)=>requireDocuments(tx,scope,[item],sourceEligibility,true),
  requireCurrentBatch:(tx,scope,items)=>requireDocuments(tx,scope,items,sourceEligibility),
  requireFrozenBatch:(tx,scope,items)=>requireDocuments(tx,scope,items,sourceEligibility,true),
 };
}
export const documentKnowledgeReader=createDocumentKnowledgeReader();
function combineKnowledge(memory:ReplyMemoryReader,documents:DocumentKnowledgeReader):ReplyKnowledgeReader {
 const reader=(item:ReplyKnowledgeItem)=>{
  if(item.kind==='document')return documents;
  if(item.kind==='memory'||item.kind==='memory_candidate')return memory;
  throw new StorageFailure('reply_knowledge_invalid');
 };
 const requireBatch=(tx:StorageTransaction,scope:DiscussionScope,items:readonly ReplyKnowledgeItem[],frozen=false)=>{
  for(const selected of [memory,documents]){
   const group=items.filter(item=>reader(item)===selected);if(!group.length)continue;
   const batch=frozen?selected.requireFrozenBatch:selected.requireCurrentBatch;
   if(batch)batch(tx,scope,group);else for(const item of group)(frozen&&selected.requireFrozen?selected.requireFrozen:selected.requireCurrent)(tx,scope,item);
  }
 };
 return {
  // 记忆按需逐条核验，文档仍整体读取；回复据此避免每次全量核验全部记忆。
  list:(tx,scope)=>memory.list(tx,scope),
  open:(tx,scope,header)=>memory.open(tx,scope,header),
  readDocuments:(tx,scope)=>documents.read(tx,scope),
  readDocument:(tx,scope,item,range)=>documents.readDocument(tx,scope,item,range),
  requireCurrent:(tx,scope,item)=>reader(item).requireCurrent(tx,scope,item),
  requireFrozen:(tx,scope,item)=>{const selected=reader(item);(selected.requireFrozen??selected.requireCurrent)(tx,scope,item);},
  requireCurrentBatch:(tx,scope,items)=>requireBatch(tx,scope,items),
  requireFrozenBatch:(tx,scope,items)=>requireBatch(tx,scope,items,true),
 };
}
/** 后台与严格消费者保持现有来源资格，不读取长期表达偏好。 */
export const combinedKnowledgeReader=combineKnowledge(memoryKnowledgeReader,documentKnowledgeReader);
/** 回复专用可信装配；后台发布和记忆写入继续使用严格默认资格。 */
export function createReplyLocalKnowledgeReader():ReplyKnowledgeReader {
 return combineKnowledge(createMemoryKnowledgeReader(assertReplyLocalSource),createDocumentKnowledgeReader(assertReplyLocalSource));
}
export const replyLocalKnowledgeReader=createReplyLocalKnowledgeReader();
