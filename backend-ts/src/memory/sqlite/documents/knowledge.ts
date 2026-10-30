import {StorageFailure,type StorageRow,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionScope} from '../../../reply/sqlite/contracts.ts';
import type {ReplyKnowledgeItem,ReplyKnowledgeReader} from '../../../reply/sqlite/candidates/contracts.ts';
import {available} from '../management/qualification.ts';
import {memoryKnowledgeReader} from '../management/knowledge.ts';
import {documentSources,publicationMembers} from './basis.ts';
import type {ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';

/** 发布修订也随实际输入冻结，空集合的切换由12的范围修订快照保护。 */
export interface DocumentKnowledgeItem extends ReplyKnowledgeItem {documentRevision:bigint}

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
function scopeItems(tx:StorageTransaction,scope:DiscussionScope,scopeKind:'self'|'contact'):DocumentKnowledgeItem[]{
 const ownerId=scope.ownerId,contactId=scopeKind==='self'?null:scope.contactId;
 const current=scopeKind==='self'?tx.get('SELECT current_publication_id,document_revision FROM owner WHERE owner_id=?',[ownerId]):tx.get('SELECT current_publication_id,document_revision FROM contact WHERE owner_id=? AND id=?',[ownerId,contactId]);
 if(!current||current.current_publication_id===null)return [];
 try{
  const cache=new Map<string,ReplySource[]>(),publicationId=String(current.current_publication_id),members=publicationMembers(tx,ownerId,publicationId,scopeKind,contactId,cache);
  // 完整集合复核后再一次返回：其中任何成员失效时不能把剩余成员当成当前集合。
  return members.map(member=>{
   const sources=documentSources(tx,ownerId,String(member.document_id),member.version_no as bigint,new Set(),cache);
   if(scopeKind==='contact'&&sources.some(source=>source.contactId!==contactId))throw new StorageFailure('document_scope_stale');
   return {kind:'document',id:String(member.document_id),versionNo:member.version_no as bigint,scopeKind:scopeKind==='self'?'owner':'contact',contactId,publicationId,
    text:textOf(tx,ownerId,member),qualification:'published',sources,documentRevision:current.document_revision as bigint};
  });
 }catch(error){if(error instanceof StorageFailure)return [];throw error;}
}
function items(tx:StorageTransaction,scope:DiscussionScope):DocumentKnowledgeItem[]{
 available(tx,scope.ownerId,{scopeKind:'contact',contactId:scope.contactId});
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[scope.ownerId]))return [];
 return [...scopeItems(tx,scope,'self'),...scopeItems(tx,scope,'contact')];
}
function serialized(value:unknown):string{return JSON.stringify(value,(_key,v)=>typeof v==='bigint'?v.toString():v);}
export const documentKnowledgeReader:ReplyKnowledgeReader={
 read:items,
 requireCurrent(tx,scope,item){
  const previous=item as DocumentKnowledgeItem;
  available(tx,scope.ownerId,{scopeKind:'contact',contactId:scope.contactId});
  if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[scope.ownerId]))throw new StorageFailure('document_knowledge_stale');
  const found=scopeItems(tx,scope,item.scopeKind==='owner'?'self':'contact').find(value=>value.id===item.id&&value.scopeKind===item.scopeKind&&value.contactId===item.contactId);
  if(!found||item.kind!=='document'||found.versionNo!==item.versionNo||found.publicationId!==item.publicationId||found.documentRevision!==previous.documentRevision
   ||found.qualification!==item.qualification||found.text!==item.text||serialized(found.sources)!==serialized(item.sources))throw new StorageFailure('document_knowledge_stale');
 },
};
/** 按kind分派已存在的08记忆读取与09完整文档集合，回复不加载长期表达偏好。 */
export const combinedKnowledgeReader:ReplyKnowledgeReader={
 read(tx,scope){return [...memoryKnowledgeReader.read(tx,scope),...documentKnowledgeReader.read(tx,scope)];},
 requireCurrent(tx,scope,item){
  if(item.kind==='document')return documentKnowledgeReader.requireCurrent(tx,scope,item);
  if(item.kind==='memory'||item.kind==='memory_candidate')return memoryKnowledgeReader.requireCurrent(tx,scope,item);
  throw new StorageFailure('reply_knowledge_invalid');
 },
};
