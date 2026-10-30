import {randomUUID} from 'node:crypto';
import {StorageFailure,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {requireDiscussion} from '../actions.ts';
import {requireReplyInput} from './input.ts';
import {quarantinedDiscussionImpact} from '../deletion.ts';
import type {DiscussionScope} from '../contracts.ts';
import type {ReplyCandidateVersion,ReplyKnowledgeReader} from './contracts.ts';
function fail(code:string):never{throw new StorageFailure(code);}
export function readParts(value:unknown):string[]{
 if(!Array.isArray(value)||!value.length||value.length>8||value.some(p=>typeof p!=='string'||!p.trim()||p.length>10000)||value.join('').length>30000)fail('reply_content_invalid');
 return value as string[];
}
export function parseReplyOutput(text:string):{parts:string[];basis:number[]}[]{
 let result;try{result=JSON.parse(text);}catch{fail('reply_output_invalid');}
 if(!result||Object.keys(result).length!==1||!Array.isArray(result.candidates)||!result.candidates.length||result.candidates.length>5)fail('reply_output_invalid');
 return result.candidates.map((c:any)=>{
  if(!c||Object.keys(c).sort().join(',')!=='basis,parts'||!Array.isArray(c.basis)||!c.basis.length||c.basis.length>50||c.basis.some((n:any)=>!Number.isSafeInteger(n)||n<1)||new Set(c.basis).size!==c.basis.length)fail('reply_output_invalid');
  return {parts:readParts(c.parts),basis:c.basis};
 });
}
export function requireCandidate(tx:StorageTransaction,i:DiscussionScope&{candidateId:string;versionNo?:number},reader:ReplyKnowledgeReader){
 requireDiscussion(tx,i);
 const candidate=tx.get(`SELECT k.*,r.discussion_id,r.contact_id FROM reply_candidate k JOIN reply_request r ON r.owner_id=k.owner_id AND r.id=k.request_id WHERE k.owner_id=? AND k.id=? AND r.contact_id=? AND r.discussion_id=? AND r.state='committed'`,[i.ownerId,i.candidateId,i.contactId,i.discussionId])??fail('reply_candidate_unavailable');
 if(quarantinedDiscussionImpact(tx,i.ownerId).requests.has(String(candidate.request_id)))fail('reply_source_unavailable');
 for(const context of tx.all('SELECT id FROM reply_context WHERE owner_id=? AND request_id=?',[i.ownerId,candidate.request_id]))requireReplyInput(tx,i,String(context.id),reader);
 const version=tx.get(`SELECT * FROM reply_candidate_version WHERE owner_id=? AND candidate_id=? ${i.versionNo===undefined?'ORDER BY version_no DESC LIMIT 1':'AND version_no=?'}`,i.versionNo===undefined?[i.ownerId,i.candidateId]:[i.ownerId,i.candidateId,i.versionNo])??fail('reply_content_unavailable');
 if(version.content_state!=='available')fail('reply_content_unavailable');
 const parts=tx.all('SELECT part_no,text_body FROM reply_version_part WHERE owner_id=? AND candidate_id=? AND version_no=? ORDER BY part_no',[i.ownerId,i.candidateId,version.version_no]);
 if(BigInt(parts.length)!==version.part_count||parts.some((p,index)=>p.part_no!==BigInt(index+1)))fail('reply_content_unavailable');
 return {candidate,version,parts};
}
export function versionView(tx:StorageTransaction,ownerId:string,candidateId:string,versionNo:bigint):ReplyCandidateVersion{
 const v=tx.get('SELECT * FROM reply_candidate_version WHERE owner_id=? AND candidate_id=? AND version_no=?',[ownerId,candidateId,versionNo])!;
 return {candidateId,versionNo:Number(v.version_no),origin:v.origin_kind==='model'?'model':'manual',parentVersionNo:v.parent_version_no===null?null:Number(v.parent_version_no),
  parts:tx.all('SELECT text_body FROM reply_version_part WHERE owner_id=? AND candidate_id=? AND version_no=? ORDER BY part_no',[ownerId,candidateId,versionNo]).map(p=>String(p.text_body)),
  basis:tx.all('SELECT b.*,x.kind,x.text_body FROM reply_basis b JOIN reply_candidate_input x ON x.owner_id=b.owner_id AND x.context_id=b.context_id AND x.item_no=b.item_no WHERE b.owner_id=? AND b.candidate_id=? AND b.version_no=? ORDER BY basis_no',[ownerId,candidateId,versionNo]).map(b=>({itemNo:Number(b.item_no),kind:String(b.kind),text:String(b.text_body),verification:b.verification_state as 'actual_input'|'inherited_unverified'}))};
}
export function insertModelCandidates(tx:StorageTransaction,i:{ownerId:string;requestId:string;contextId:string;callId:string;text:string}):void{
 const output=parseReplyOutput(i.text);
 for(const [index,c] of output.entries()){
  for(const itemNo of c.basis)if(!tx.get(`SELECT 1 FROM reply_execution_input x JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.event_id WHERE x.owner_id=? AND x.context_id=? AND x.item_no=? AND e.kind='model_request' AND e.originated_call_id=?`,[i.ownerId,i.contextId,itemNo,i.callId]))fail('reply_basis_not_actual_input');
  const id=randomUUID();tx.run('INSERT INTO reply_candidate VALUES(?,?,?,?)',[i.ownerId,id,i.requestId,index+1]);
  tx.run("INSERT INTO reply_candidate_version VALUES(?,?,1,'model',NULL,?,?,'available',?)",[i.ownerId,id,i.callId,index+1,c.parts.length]);
  for(const [partNo,part] of c.parts.entries())tx.run('INSERT INTO reply_version_part VALUES(?,?,1,?,?)',[i.ownerId,id,partNo+1,part]);
  for(const [basisNo,itemNo] of c.basis.entries())tx.run("INSERT INTO reply_basis VALUES(?,?,1,?,?,?,'actual_input')",[i.ownerId,id,basisNo+1,i.contextId,itemNo]);
 }
}
