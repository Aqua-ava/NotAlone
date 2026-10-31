import {requireSkillRun} from '../../../skills/sqlite/storage.ts';
import type {SkillRunRevision} from '../../../skills/sqlite/contracts.ts';
import {StorageFailure,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {assertSourceEligibility} from '../../../history/sqlite/source.ts';
import {requireDiscussion} from '../actions.ts';
import {invalidHistoryDiscussionImpact} from '../deletion.ts';
import {decode,encode} from '../requests.ts';
import type {DiscussionScope} from '../contracts.ts';
import type {ReplyKnowledgeItem,ReplyKnowledgeReader,ReplySource} from './contracts.ts';
import type {ReplyWorkspaceSnapshot} from './workspace.ts';
import {toneLabel} from './workspace.ts';
function fail(code:string):never{throw new StorageFailure(code);}
function coverageSnapshot(value:string):unknown{const parsed=JSON.parse(value);return parsed?.kind==='reply_candidate_request_v1'?parsed.coverage:parsed;}
export interface FrozenReplyInput {itemNo:number;kind:string;text:string;identity:object;sources:ReplySource[]}
function source(tx:StorageTransaction,ownerId:string,s:ReplySource):void{
 assertSourceEligibility(tx,{owner_id:ownerId,contact_id:s.contactId,record_id:s.recordId,message_id:s.messageId});
 if(!tx.get("SELECT 1 FROM message WHERE owner_id=? AND contact_id=? AND id=? AND interpretation_revision=? AND availability='available'",[ownerId,s.contactId,s.messageId,s.acceptedRevision]))fail('reply_source_unavailable');
}
function knowledge(tx:StorageTransaction,scope:DiscussionScope,item:ReplyKnowledgeItem,reader:ReplyKnowledgeReader):void{
 if(!['memory','memory_candidate','document'].includes(item.kind)||typeof item.id!=='string'||!item.id||typeof item.versionNo!=='bigint'||item.versionNo<1n
  ||!item.text?.trim()||item.text.length>100_000||!Array.isArray(item.sources)||item.sources.length>1000
  ||item.scopeKind==='owner'&&item.contactId!==null||item.scopeKind==='contact'&&item.contactId!==scope.contactId
  ||!['owner','contact'].includes(item.scopeKind)
  ||item.kind==='document'&&(item.qualification!=='published'||!item.publicationId)
  ||item.kind==='memory_candidate'&&item.qualification!=='unconfirmed'
  ||item.kind==='memory'&&!['auto','confirmed'].includes(item.qualification))fail('reply_knowledge_invalid');
 if(item.scopeKind==='contact'&&item.sources.some(s=>s.contactId!==scope.contactId))fail('reply_knowledge_scope');
 reader.requireCurrent(tx,scope,item);for(const s of item.sources)source(tx,scope.ownerId,s);
}
export function freezeReplyInput(tx:StorageTransaction,i:DiscussionScope&{contextId:string;requestId:string;workspace?:ReplyWorkspaceSnapshot},reader:ReplyKnowledgeReader):FrozenReplyInput[]{
 requireDiscussion(tx,i);
 const includeRelatedData=!i.workspace||i.workspace.includeRelationshipContext&&i.workspace.excludedMessageIds.length===0;
 const items:Omit<FrozenReplyInput,'itemNo'>[]=[];
 for(const row of tx.all('SELECT x.*,e.body,m.text_body,m.sender_role FROM reply_context_item x LEFT JOIN discussion_entry e ON e.owner_id=x.owner_id AND e.id=x.entry_id LEFT JOIN message m ON m.owner_id=x.owner_id AND m.id=x.message_id WHERE x.owner_id=? AND x.context_id=? ORDER BY x.item_no',[i.ownerId,i.contextId])){
  if(row.kind==='skill')continue;
  if(i.workspace&&row.kind==='entry')continue;
  const sources:ReplySource[]=row.kind==='message'?[{contactId:String(row.source_contact_id),messageId:String(row.message_id),recordId:String(row.record_id),acceptedRevision:row.accepted_revision as bigint}]:[];
  items.push({kind:String(row.kind),identity:{contextItemNo:row.item_no},text:String(row.kind==='message'?`${row.sender_role==='owner'?'我':'对方'}：${row.text_body}`:row.body),sources});
 }
 if(i.workspace){
  const w=i.workspace;
  items.push({kind:'entry',identity:{workspaceItem:'request',action:w.action,tone:w.tone,includeRelationshipContext:w.includeRelationshipContext,excludedMessageIds:w.excludedMessageIds,selectedPackageId:w.selectedPackageId,carriedSelectionId:w.carriedSelectionId},
   text:`本次工作区请求：${w.action==='suggest'?'用户请求帮我想想；尚未确认任何立场，候选只是可选建议。':'用户请求帮我表达；请忠实组织本次想法，不补写未提供的立场。'}\n语气要求：${toneLabel(w.tone)}\n关系背景：${w.includeRelationshipContext?'已启用':'已关闭；不依据自动聊天、旧讨论或关系资料'}`,
   sources:[]});
  if(w.draftText.trim())items.push({kind:'entry',identity:{workspaceItem:'draft'},text:`本次想法/草稿（独立于补充背景）：\n${w.draftText}`,sources:[]});
  if(w.instruction.trim())items.push({kind:'entry',identity:{workspaceItem:'instruction'},text:`本次一次性写作要求：\n${w.instruction}`,sources:[]});
  if(w.contextText.trim())items.push({kind:'entry',identity:{workspaceItem:'supplemental_context'},text:`本次补充背景（独立于想法/草稿，仅作用本次）：\n${w.contextText}`,sources:[]});
 }
 for(const item of includeRelatedData?reader.read(tx,i):[]){
  knowledge(tx,i,item,reader);
  items.push({kind:item.kind,identity:item,text:(item.qualification==='unconfirmed'?'【未确认候选，仅供参考】':'')+item.text,sources:item.sources});
 }
 const details=tx.get('SELECT * FROM reply_candidate_request WHERE owner_id=? AND request_id=?',[i.ownerId,i.requestId])??fail('reply_request_unavailable');
 if(details.coverage_warning&&includeRelatedData)items.push({kind:'coverage',identity:{coverage:coverageSnapshot(String(details.coverage_json))},text:String(details.coverage_warning),sources:[]});
 if(details.carried_selection_id&&includeRelatedData){
  const selection=requireSelection(tx,i,String(details.carried_selection_id),reader);
  const sources=tx.all(`SELECT DISTINCT s.* FROM reply_candidate_input_source s JOIN reply_context c ON c.owner_id=s.owner_id AND c.id=s.context_id WHERE c.owner_id=? AND c.request_id=?`,[i.ownerId,selection.request_id]).map(s=>({contactId:String(s.source_contact_id),recordId:String(s.record_id),messageId:String(s.message_id),acceptedRevision:s.accepted_revision as bigint}));
  const parts=tx.all('SELECT text_body FROM reply_version_part WHERE owner_id=? AND candidate_id=? AND version_no=? ORDER BY part_no',[i.ownerId,selection.candidate_id,selection.version_no]);
  items.push({kind:'selection',identity:{selectionId:String(selection.id),candidateId:String(selection.candidate_id),versionNo:selection.version_no},text:'用户明确选择继续的候选：\n'+parts.map(p=>String(p.text_body)).join('\n'),sources});
 }
 const owner=tx.get('SELECT memory_revision,document_revision FROM owner WHERE owner_id=?',[i.ownerId])!,contact=tx.get('SELECT memory_revision,document_revision FROM contact WHERE owner_id=? AND id=?',[i.ownerId,i.contactId])!;
 tx.run('INSERT INTO reply_candidate_context VALUES(?,?,?,?,?,?)',[i.ownerId,i.contextId,owner.memory_revision,contact.memory_revision,owner.document_revision,contact.document_revision]);
 return items.map((item,index)=>{
  const itemNo=index+1;
  tx.run('INSERT INTO reply_candidate_input VALUES(?,?,?,?,?,?)',[i.ownerId,i.contextId,itemNo,item.kind,encode(item.identity),item.text]);
  for(const s of item.sources){source(tx,i.ownerId,s);tx.run('INSERT INTO reply_candidate_input_source VALUES(?,?,?,?,?,?,?)',[i.ownerId,i.contextId,itemNo,s.contactId,s.recordId,s.messageId,s.acceptedRevision]);}
  return {...item,itemNo};
 });
}
export function requireReplyInput(tx:StorageTransaction,scope:DiscussionScope,contextId:string,reader:ReplyKnowledgeReader,options:{ignoreSkill?:boolean}={}):void{
 requireDiscussion(tx,scope);
 const context=tx.get("SELECT * FROM reply_context WHERE owner_id=? AND id=? AND contact_id=? AND discussion_id=? AND state='active'",[scope.ownerId,contextId,scope.contactId,scope.discussionId])??fail('reply_source_unavailable');
 if(!options.ignoreSkill)requireSkillRun(tx,scope.ownerId,decode<SkillRunRevision>(String(context.skill_run_json)));
 const frozen=tx.get('SELECT * FROM reply_candidate_context WHERE owner_id=? AND context_id=?',[scope.ownerId,contextId])??fail('reply_source_unavailable');
 const owner=tx.get('SELECT memory_revision,document_revision FROM owner WHERE owner_id=?',[scope.ownerId])!,contact=tx.get('SELECT memory_revision,document_revision FROM contact WHERE owner_id=? AND id=?',[scope.ownerId,scope.contactId])!;
 if(frozen.owner_memory_revision!==owner.memory_revision||frozen.owner_document_revision!==owner.document_revision||frozen.contact_memory_revision!==contact.memory_revision||frozen.contact_document_revision!==contact.document_revision)fail('reply_input_stale');
 for(const item of tx.all('SELECT * FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[scope.ownerId,contextId])){
  if(['memory','memory_candidate','document'].includes(String(item.kind)))knowledge(tx,scope,decode(String(item.identity_json)),reader);
  if(item.kind==='selection'){const id=decode<{selectionId:string}>(String(item.identity_json)).selectionId;requireSelection(tx,scope,id,reader);}
 }
 for(const s of tx.all('SELECT * FROM reply_candidate_input_source WHERE owner_id=? AND context_id=?',[scope.ownerId,contextId]))source(tx,scope.ownerId,{contactId:String(s.source_contact_id),recordId:String(s.record_id),messageId:String(s.message_id),acceptedRevision:s.accepted_revision as bigint});
 if(!tx.get("SELECT 1 FROM reply_request WHERE owner_id=? AND id=? AND state IN ('running','committed')",[scope.ownerId,context.request_id]))fail('reply_source_unavailable');
}
export function requireSelection(tx:StorageTransaction,scope:DiscussionScope,id:string,reader:ReplyKnowledgeReader){
 const row=tx.get(`SELECT s.*,v.part_count FROM reply_selection s JOIN reply_candidate k ON k.owner_id=s.owner_id AND k.id=s.candidate_id JOIN reply_request r ON r.owner_id=k.owner_id AND r.id=k.request_id JOIN reply_candidate_version v ON v.owner_id=s.owner_id AND v.candidate_id=s.candidate_id AND v.version_no=s.version_no WHERE s.owner_id=? AND s.id=? AND r.contact_id=? AND r.discussion_id=? AND r.state='committed' AND v.content_state='available'`,[scope.ownerId,id,scope.contactId,scope.discussionId])??fail('reply_selection_unavailable');
 if(invalidHistoryDiscussionImpact(tx,scope.ownerId).requests.has(String(row.request_id)))fail('reply_source_unavailable');
 const parts=tx.all('SELECT part_no FROM reply_version_part WHERE owner_id=? AND candidate_id=? AND version_no=? ORDER BY part_no',[scope.ownerId,row.candidate_id,row.version_no]);
 if(BigInt(parts.length)!==row.part_count||parts.some((p,index)=>p.part_no!==BigInt(index+1)))fail('reply_content_unavailable');
 for(const c of tx.all('SELECT id FROM reply_context WHERE owner_id=? AND request_id=?',[scope.ownerId,row.request_id]))requireReplyInput(tx,scope,String(c.id),reader);
 return row;
}
