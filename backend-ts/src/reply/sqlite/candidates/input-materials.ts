import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionScope} from '../contracts.ts';
import {requireDiscussion} from '../actions.ts';
import type {ReplyKnowledgeReader} from './contracts.ts';
import {requireCandidate} from './versions.ts';
import {inputMaterialMetadata} from './input-material-metadata.ts';

export const INPUT_MATERIAL_PAGE_MAX_BYTES=1_500_000;
const pageItemLimit=50;
function fail(code:string):never{throw new StorageFailure(code);}

/** 完整材料按真实提交调用读取；候选引用只是这些材料中的子集。 */
export function readInputMaterials(tx:StorageTransaction,i:DiscussionScope&{requestId:string;offset:number},reader:ReplyKnowledgeReader){
 requireDiscussion(tx,i);
 if(typeof i.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(i.requestId)||!Number.isSafeInteger(i.offset)||i.offset<0||i.offset>1_000_000)fail('reply_input_invalid');
 const candidate=tx.get(`SELECT k.id FROM reply_request r JOIN reply_candidate k ON k.owner_id=r.owner_id AND k.request_id=r.id
  WHERE r.owner_id=? AND r.id=? AND r.contact_id=? AND r.discussion_id=? AND r.kind='reply' AND r.state='committed' ORDER BY k.candidate_no LIMIT 1`,[i.ownerId,i.requestId,i.contactId,i.discussionId])??fail('reply_candidate_unavailable');
 requireCandidate(tx,{...i,candidateId:String(candidate.id)},reader);
 const call=tx.get(`SELECT v.call_id,c.reply_context_id,c.reply_attempt_id FROM reply_candidate_version v JOIN model_call c ON c.owner_id=v.owner_id AND c.id=v.call_id
  WHERE v.owner_id=? AND v.candidate_id=? AND v.version_no=1 AND v.origin_kind='model'`,[i.ownerId,candidate.id]);
 const event=call&&tx.get("SELECT id FROM execution_event WHERE owner_id=? AND reply_attempt_id=? AND originated_call_id=? AND kind='model_request' ORDER BY event_no DESC LIMIT 1",[i.ownerId,call.reply_attempt_id,call.call_id]);
 if(!event)return {recorded:false,items:[],nextOffset:null,total:0};
 const where='FROM reply_execution_input e JOIN reply_candidate_input x ON x.owner_id=e.owner_id AND x.context_id=e.context_id AND x.item_no=e.item_no WHERE e.owner_id=? AND e.event_id=? AND e.context_id=?';
 const bindings=[i.ownerId,event.id,call!.reply_context_id];
 const total=Number(tx.get(`SELECT COUNT(*) n ${where}`,bindings)!.n),rows=tx.all(`SELECT x.item_no,x.kind,x.text_body,x.identity_json ${where} ORDER BY x.item_no LIMIT ? OFFSET ?`,[...bindings,pageItemLimit,i.offset]);
 const items:ReturnType<typeof materialView>[]= [];let bytes=0;
 for(const row of rows){
  const item=materialView(row),size=Buffer.byteLength(JSON.stringify(item),'utf8');
  if(size>INPUT_MATERIAL_PAGE_MAX_BYTES)fail('reply_input_page_too_large');
  if(items.length&&bytes+size+1>INPUT_MATERIAL_PAGE_MAX_BYTES)break;
  items.push(item);bytes+=size+1;
 }
 return {recorded:true,items,nextOffset:i.offset+items.length<total?i.offset+items.length:null,total};
}

function materialView(row:Record<string,unknown>){
 return {itemNo:Number(row.item_no),kind:String(row.kind),text:String(row.text_body),...inputMaterialMetadata(String(row.identity_json))};
}
