import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {fail} from '../qualification.ts';

export interface DocumentActualInput {row:StorageRow;role:'memory'|'document_index'|'document_identity'|'document_body'}
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** 从本次实际请求的结构化材料确定精确版本；冻结池和来源资格不冒充模型输入。 */
export function documentActualInputs(tx:StorageTransaction,ownerId:string,stepId:string,request:unknown):DocumentActualInput[]{
 if(!object(request)||!Array.isArray(request.messages)||!Array.isArray(request.tools))return fail('document_request_invalid');
 const first=request.messages[0],block=object(first)&&Array.isArray(first.content)?first.content.find((item:unknown)=>object(item)&&item.type==='text'):null;
 let data:Record<string,any>;
 try{const parsed=JSON.parse(block?.text);if(!object(parsed))fail('document_request_invalid');data=parsed;}
 catch{return fail('document_request_invalid');}
 const inputs=tx.all(`SELECT i.*,d.version_identity,v.body AS memory_body FROM step_input i
  LEFT JOIN memory_document_version d ON d.owner_id=i.owner_id AND d.document_id=i.document_id AND d.version_no=i.document_version_no
  LEFT JOIN memory_version v ON v.owner_id=i.owner_id AND v.memory_id=i.memory_id AND v.version_no=i.memory_version_no
  WHERE i.owner_id=? AND i.step_id=? ORDER BY i.input_no`,[ownerId,stepId]);
 // version_identity 属于文档版本；记忆版本只提供正文。
 const documents=tx.all(`SELECT i.*,v.version_identity FROM step_input i JOIN memory_document_version v ON v.owner_id=i.owner_id AND v.document_id=i.document_id AND v.version_no=i.document_version_no
  WHERE i.owner_id=? AND i.step_id=? AND i.kind='document' ORDER BY i.input_no`,[ownerId,stepId]);
 const result:DocumentActualInput[]=[],byInput=new Map<string,DocumentActualInput>();
 const rank={memory:0,document_identity:1,document_index:2,document_body:3};
 const add=(row:StorageRow,role:DocumentActualInput['role'])=>{
  const key=String(row.input_no),old=byInput.get(key);
  if(old){if(rank[role]>rank[old.role])old.role=role;return;}
  const item={row,role};byInput.set(key,item);result.push(item);
 };
 const memories=()=>{
  if(!Array.isArray(data.memories))fail('document_request_invalid');
  for(const memory of data.memories){
   if(!object(memory)||typeof memory.memory_id!=='string'||!Number.isSafeInteger(memory.revision)||memory.revision<1)fail('document_request_invalid');
   const row=inputs.find(i=>i.kind==='memory'&&i.memory_id===memory.memory_id&&i.memory_version_no===BigInt(memory.revision));
   const body=memory.text??memory.verbatim_text;
   if(!row||typeof body!=='string'||body!==row.memory_body)fail('document_request_unbound');
   add(row!,'memory');
  }
 };
 const document=(value:unknown,role:DocumentActualInput['role'],required=true)=>{
  if(!object(value)||typeof value.version_id!=='string'){if(required)fail('document_request_unbound');return;}
  const row=documents.find(i=>i.version_identity===value.version_id);
  if(!row||(typeof value.scenario_id==='string'&&row.document_id!==value.scenario_id)){if(required)fail('document_request_unbound');return;}
  add(row!,role);
 };
 const documentList=(value:unknown,role:DocumentActualInput['role'])=>{if(!Array.isArray(value))return fail('document_request_invalid');for(const item of value)document(item,role);};
 const identity=(value:unknown)=>{if(typeof value!=='string')return;const row=documents.find(i=>i.version_identity===value);if(row)add(row,'document_identity');};
 if(data.layer==='l2'){
  memories();documentList(data.documents,'document_index');
  // 后续请求只有成功 read 的工具结果才包含该旧场景正文。
  const reads=new Map<string,string>();
  for(const message of request.messages.slice(1)){
   if(!object(message))continue;
   if(message.role==='assistant'&&Array.isArray(message.content))for(const call of message.content){
    if(!object(call)||call.type!=='tool-call'||call.name!=='read'||typeof call.id!=='string')continue;
    try{const args=JSON.parse(call.arguments);if(typeof args?.path==='string')reads.set(call.id,args.path);}catch{/* 无效工具调用不会产生可用正文。 */}
   }
   if(message.role==='tool'&&!message.isError&&typeof message.toolCallId==='string'){
    const path=reads.get(message.toolCallId),row=documents.find(i=>path===`${i.document_id}.md`);
    if(row)add(row,'document_body');
   }
  }
 }else if(data.layer==='l3'){
  if(data.existing_profile!==null&&data.existing_profile!==undefined)document(data.existing_profile,'document_body');
  documentList(data.changed_scenarios,'document_body');
  if(!Array.isArray(data.removed_scenario_version_ids))fail('document_request_invalid');
  data.removed_scenario_version_ids.forEach(identity);identity(data.base_profile_version_id);
  documentList(data.scenarios,'document_body');memories();documentList(data.documents,'document_index');
 }else if(object(data.proposal)&&Array.isArray(data.proposal.scenarios)){
  memories();
  for(const scenario of data.proposal.scenarios){
   if(!object(scenario))continue;
   if(Array.isArray(scenario.replaces))scenario.replaces.forEach(identity);
   if(typeof scenario.scenario_id==='string'){
    const matches=documents.filter(i=>i.document_id===scenario.scenario_id);if(matches.length===1)add(matches[0]!,'document_identity');
   }
  }
 }else if(object(data.proposal)&&Array.isArray(data.proposal.entries)){
  documentList(data.scenarios,'document_body');memories();
 }else fail('document_request_invalid');
 return result;
}
