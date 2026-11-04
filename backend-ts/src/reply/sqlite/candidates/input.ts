import {selectReplyKnowledge} from './knowledge-budget.ts';
import {requireSkillRun} from '../../../skills/sqlite/storage.ts';
import type {SkillRunRevision} from '../../../skills/sqlite/contracts.ts';
import {StorageFailure,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {assertReplyLocalSources} from '../../../history/sqlite/reply-local-source.ts';
import {requireDiscussion} from '../actions.ts';
import {hasCurrentReplyDependencies} from '../provenance.ts';
import {decode,encode} from '../requests.ts';
import type {DiscussionScope} from '../contracts.ts';
import type {ReplyKnowledgeItem,ReplyKnowledgeReader,ReplySource} from './contracts.ts';
import type {ReplyWorkspaceSnapshot} from './workspace.ts';
import {toneLabel} from './workspace.ts';
function fail(code:string):never{throw new StorageFailure(code);}
function coverageSnapshot(value:string):unknown{const parsed=JSON.parse(value);return parsed?.kind==='reply_candidate_request_v1'?parsed.coverage:parsed;}
export interface FrozenReplyInput {itemNo:number;kind:string;text:string;identity:object;sources:ReplySource[]}
export function selectionSourceContacts(tx:StorageTransaction,i:DiscussionScope&{selectionId:string}):string[]{
 const row=tx.get(`SELECT r.id FROM reply_selection s JOIN reply_candidate k ON k.owner_id=s.owner_id AND k.id=s.candidate_id
  JOIN reply_request r ON r.owner_id=k.owner_id AND r.id=k.request_id JOIN reply_candidate_version v ON v.owner_id=s.owner_id AND v.candidate_id=s.candidate_id AND v.version_no=s.version_no
  WHERE s.owner_id=? AND s.id=? AND r.contact_id=? AND r.discussion_id=? AND r.state='committed' AND v.content_state='available'`,[i.ownerId,i.selectionId,i.contactId,i.discussionId])??fail('reply_selection_unavailable');
 return tx.all(`SELECT x.source_contact_id FROM reply_context c JOIN reply_context_item x ON x.owner_id=c.owner_id AND x.context_id=c.id
  WHERE c.owner_id=? AND c.request_id=? AND x.kind='message' UNION SELECT x.source_contact_id FROM reply_context c
  JOIN reply_candidate_input_source x ON x.owner_id=c.owner_id AND x.context_id=c.id WHERE c.owner_id=? AND c.request_id=?`,[i.ownerId,row.id,i.ownerId,row.id]).map(source=>String(source.source_contact_id));
}
/** 来源准备只涉及本次输入实际引用的联系人，不扫描或恢复整个联系人目录；旧讨论 entry 不提供候选来源。 */
export function replySourceContacts(tx:StorageTransaction,i:DiscussionScope&{requestId:string;items:{kind:string;sourceContactId?:string}[];workspace?:ReplyWorkspaceSnapshot},reader:ReplyKnowledgeReader):string[]{
 const contacts=new Set<string>();
 for(const item of i.items){
  if(item.kind==='message'&&item.sourceContactId===i.contactId)contacts.add(i.contactId);
 }
 if(!i.workspace||i.workspace.includeRelationshipContext){
  for(const item of reader.read(tx,i))for(const source of item.sources)contacts.add(source.contactId);
  const carried=tx.get('SELECT carried_selection_id FROM reply_candidate_request WHERE owner_id=? AND request_id=?',[i.ownerId,i.requestId]);
  if(carried?.carried_selection_id)for(const contactId of selectionSourceContacts(tx,{...i,selectionId:String(carried.carried_selection_id)}))contacts.add(contactId);
 }
 return [...contacts];
}
function sources(tx:StorageTransaction,ownerId:string,items:readonly ReplySource[]):void{
 if(!items.length)return;
 assertReplyLocalSources(tx,items.map(s=>({owner_id:ownerId,contact_id:s.contactId,record_id:s.recordId,message_id:s.messageId})));
 const rows=JSON.stringify(items.map(s=>[s.contactId,s.messageId,String(s.acceptedRevision)]));
 const valid=tx.get(`SELECT count(*) n FROM json_each(?) i JOIN message m ON m.owner_id=?
  AND m.contact_id=json_extract(i.value,'$[0]') AND m.id=json_extract(i.value,'$[1]')
  AND m.interpretation_revision=CAST(json_extract(i.value,'$[2]') AS INTEGER) AND m.availability='available'`,[rows,ownerId]);
 if(valid?.n!==BigInt(items.length))fail('reply_source_unavailable');
}
function knowledge(tx:StorageTransaction,scope:DiscussionScope,items:readonly ReplyKnowledgeItem[],reader:ReplyKnowledgeReader,frozen=false):void{
 if(!items.length)return;
 for(const item of items){
 if(!['memory','memory_candidate','document'].includes(item.kind)||typeof item.id!=='string'||!item.id||typeof item.versionNo!=='bigint'||item.versionNo<1n
  ||!item.text?.trim()||item.text.length>100_000||!Array.isArray(item.sources)||item.sources.length>1000
  ||item.scopeKind==='owner'&&item.contactId!==null||item.scopeKind==='contact'&&item.contactId!==scope.contactId
  ||!['owner','contact'].includes(item.scopeKind)
  ||item.kind==='document'&&(item.qualification!=='published'||!item.publicationId)
  ||item.kind==='memory_candidate'&&item.qualification!=='unconfirmed'
  ||item.kind==='memory'&&!['auto','confirmed'].includes(item.qualification))fail('reply_knowledge_invalid');
 if(item.scopeKind==='contact'&&item.sources.some(s=>s.contactId!==scope.contactId))fail('reply_knowledge_scope');
  sources(tx,scope.ownerId,item.sources);
 }
 const batch=frozen?reader.requireFrozenBatch:reader.requireCurrentBatch;
 if(batch)batch(tx,scope,items);else for(const item of items)(frozen&&reader.requireFrozen?reader.requireFrozen:reader.requireCurrent)(tx,scope,item);
}
export function freezeReplyInput(tx:StorageTransaction,i:DiscussionScope&{contextId:string;requestId:string;workspace?:ReplyWorkspaceSnapshot;queryText?:string},reader:ReplyKnowledgeReader):FrozenReplyInput[]{
 requireDiscussion(tx,i);
 const includeRelatedData=!i.workspace||i.workspace.includeRelationshipContext;
 const items:Omit<FrozenReplyInput,'itemNo'>[]=[];
 // 候选只冻结本次消息；entry 是旧讨论兼容槽，Skill 走独立受控读取，均不隐式成为候选材料，也不读取 discussion_entry 正文。
 for(const row of tx.all('SELECT x.*,m.text_body,m.sender_role FROM reply_context_item x LEFT JOIN message m ON m.owner_id=x.owner_id AND m.id=x.message_id WHERE x.owner_id=? AND x.context_id=? ORDER BY x.item_no',[i.ownerId,i.contextId])){
  if(row.kind!=='message')continue;
  const sources:ReplySource[]=[{contactId:String(row.source_contact_id),messageId:String(row.message_id),recordId:String(row.record_id),acceptedRevision:row.accepted_revision as bigint}];
  items.push({kind:'message',identity:{contextItemNo:row.item_no},text:`${row.sender_role==='owner'?'我':'对方'}：${row.text_body}`,sources});
 }
 // 旧输入合同的文字兼容入口仍保留，但当前请求正文由本次具名请求直接冻结，不从 discussion_entry 回读。
 if(!i.workspace&&typeof i.queryText==='string'&&i.queryText.trim())items.push({kind:'entry',identity:{requestInput:true},text:i.queryText,sources:[]});
 if(i.workspace){
  const w=i.workspace;
  items.push({kind:'entry',identity:{workspaceItem:'request',action:w.action,tone:w.tone,includeRelationshipContext:w.includeRelationshipContext,selectedPackageId:w.selectedPackageId,carriedSelectionId:w.carriedSelectionId},
   text:`本次工作区请求：${w.action==='suggest'?'用户请求帮我想想；尚未确认任何立场，候选只是可选建议。':'用户请求帮我表达；请忠实组织本次想法，不补写未提供的立场。'}\n语气要求：${toneLabel(w.tone)}\n关系背景：${w.includeRelationshipContext?'已启用':'已关闭；不依据自动聊天、旧讨论或关系资料'}`,
   sources:[]});
  if(w.draftText.trim())items.push({kind:'entry',identity:{workspaceItem:'draft'},text:`本次想法/草稿（独立于补充背景）：\n${w.draftText}`,sources:[]});
  if(w.instruction.trim())items.push({kind:'entry',identity:{workspaceItem:'instruction'},text:`本次一次性写作要求：\n${w.instruction}`,sources:[]});
  if(w.contextText.trim())items.push({kind:'entry',identity:{workspaceItem:'supplemental_context'},text:`本次补充背景（独立于想法/草稿，仅作用本次）：\n${w.contextText}`,sources:[]});
 }
 const query=i.workspace?[i.workspace.draftText,i.workspace.instruction,i.workspace.contextText,...items.filter(item=>item.kind==='message').map(item=>item.text)].filter(Boolean).join('\n'):[i.queryText??items.filter(item=>item.kind==='entry').at(-1)?.text??'',...items.filter(item=>item.kind==='message').map(item=>item.text)].join('\n');
 const related=includeRelatedData?selectReplyKnowledge(reader.read(tx,i),query):[];
 knowledge(tx,i,related,reader);
 for(const item of related){
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
 sources(tx,i.ownerId,items.flatMap(item=>item.sources));
 return items.map((item,index)=>{
  const itemNo=index+1;
  tx.run('INSERT INTO reply_candidate_input VALUES(?,?,?,?,?,?)',[i.ownerId,i.contextId,itemNo,item.kind,encode(item.identity),item.text]);
  for(const s of item.sources)tx.run('INSERT INTO reply_candidate_input_source VALUES(?,?,?,?,?,?,?)',[i.ownerId,i.contextId,itemNo,s.contactId,s.recordId,s.messageId,s.acceptedRevision]);
  return {...item,itemNo};
 });
}
export function requireReplyInput(tx:StorageTransaction,scope:DiscussionScope,contextId:string,reader:ReplyKnowledgeReader,options:{ignoreSkill?:boolean}={}):void{
 requireDiscussion(tx,scope);
 const context=tx.get("SELECT * FROM reply_context WHERE owner_id=? AND id=? AND contact_id=? AND discussion_id=? AND state='active'",[scope.ownerId,contextId,scope.contactId,scope.discussionId])??fail('reply_source_unavailable');
 if(!options.ignoreSkill)requireSkillRun(tx,scope.ownerId,decode<SkillRunRevision>(String(context.skill_run_json)));
 if(!tx.get('SELECT 1 FROM reply_candidate_context WHERE owner_id=? AND context_id=?',[scope.ownerId,contextId]))fail('reply_source_unavailable');
 const inputs=tx.all('SELECT * FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[scope.ownerId,contextId]);
 knowledge(tx,scope,inputs.filter(item=>['memory','memory_candidate','document'].includes(String(item.kind))).map(item=>decode<ReplyKnowledgeItem>(String(item.identity_json))),reader,true);
 for(const item of inputs){
  if(item.kind==='selection'){const id=decode<{selectionId:string}>(String(item.identity_json)).selectionId;requireSelection(tx,scope,id,reader);}
 }
 sources(tx,scope.ownerId,tx.all('SELECT * FROM reply_candidate_input_source WHERE owner_id=? AND context_id=?',[scope.ownerId,contextId]).map(s=>({contactId:String(s.source_contact_id),recordId:String(s.record_id),messageId:String(s.message_id),acceptedRevision:s.accepted_revision as bigint})));
 if(!tx.get("SELECT 1 FROM reply_request WHERE owner_id=? AND id=? AND state IN ('running','committed')",[scope.ownerId,context.request_id]))fail('reply_source_unavailable');
}
export function requireSelection(tx:StorageTransaction,scope:DiscussionScope,id:string,reader:ReplyKnowledgeReader){
 const row=tx.get(`SELECT s.*,v.part_count FROM reply_selection s JOIN reply_candidate k ON k.owner_id=s.owner_id AND k.id=s.candidate_id JOIN reply_request r ON r.owner_id=k.owner_id AND r.id=k.request_id JOIN reply_candidate_version v ON v.owner_id=s.owner_id AND v.candidate_id=s.candidate_id AND v.version_no=s.version_no WHERE s.owner_id=? AND s.id=? AND r.contact_id=? AND r.discussion_id=? AND r.state='committed' AND v.content_state='available'`,[scope.ownerId,id,scope.contactId,scope.discussionId])??fail('reply_selection_unavailable');
 if(!hasCurrentReplyDependencies(tx,{ownerId:scope.ownerId,requestIds:[String(row.request_id)]}))fail('reply_source_unavailable');
 const parts=tx.all('SELECT part_no FROM reply_version_part WHERE owner_id=? AND candidate_id=? AND version_no=? ORDER BY part_no',[scope.ownerId,row.candidate_id,row.version_no]);
 if(BigInt(parts.length)!==row.part_count||parts.some((p,index)=>p.part_no!==BigInt(index+1)))fail('reply_content_unavailable');
 for(const c of tx.all('SELECT id FROM reply_context WHERE owner_id=? AND request_id=?',[scope.ownerId,row.request_id]))requireReplyInput(tx,scope,String(c.id),reader);
 return row;
}
