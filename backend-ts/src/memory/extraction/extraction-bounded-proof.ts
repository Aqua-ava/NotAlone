/** nullable-proof-v3 的受限提案解析；语义完全由现有六类有限图复验。 */
import {canonicalJSON,digest,type Evidence} from '../overview/contact-overview-evidence.ts';
import {boundedContract} from '../overview/contact-overview-bounded-contract.ts';
import {boundedBasisResult} from '../overview/contact-overview-bounded-graph.ts';
import {length,type Message} from '../overview/contact-overview-bounded-body.ts';
import {boundedMessages,boundedRepresentation,validateBoundedBodySources} from './extraction-bounded.ts';
import {
  ExtractionProtocolError,uuid,
  type ExtractedFact,type ExtractionWindow,
} from './extraction-protocol.ts';

export interface ProofSpan {start:number;end:number;message_id?:string}
export interface AtomLink {rule_id:string;variant_id:string;source:ProofSpan;candidate:ProofSpan}
export interface ReferenceLink {rule_id:string;mention:ProofSpan;target:ProofSpan;binding:ProofSpan|null}
export interface ReportedLink {rule_id:string;frame:string;source:ProofSpan;candidate:ProofSpan}
export interface ProofProposal {
  version:3;
  atom_links:AtomLink[]|null;
  reference:ReferenceLink[]|null;
  reported:ReportedLink[]|null;
}
export interface ProofVerification {
  status:'verified'|'unknown'|'unsupported';
  reason:string;
  semantic_basis:Evidence|null;
}
const VARIANTS:Record<string,readonly string[]>={
  BR_AUTHOR_ARRIVAL_V1:['direct_quote'],
  BR_KIN_LEND_V1:['completed_inline','negative_inline','completed_cross','negative_cross'],
  BR_COMPLETED_QA_V1:['completed_answer'],
  BR_TWO_ROLES_V1:['completed_inline','negative_inline','completed_cross','negative_cross'],
  BR_REQUEST_V1:['reported_inline','reported_cross','received_inline','received_cross'],
  BR_COND_RUN_V1:['conditional_plan'],
};
const FRAMES=new Set(['direct','reported_request','received_request']);
const fail=(message='来源证明字段不符合契约。'):never=>{throw new ExtractionProtocolError(message);};
function sourceStateDigest(snapshots:readonly Record<string,unknown>[]):string|null{
  const names=['source_ref_id','source_id','source_kind','locator','raw_payload','source_content_sha256'];
  const rows:Record<string,unknown>[]=[];
  for(const item of snapshots){
    if(!names.every(name=>Object.hasOwn(item,name))||!['source_document','local_wechat_observation'].includes(item.source_kind as string)
      ||typeof item.locator!=='string'||!item.locator.trim()||!item.raw_payload||typeof item.raw_payload!=='object'||Array.isArray(item.raw_payload)
      ||item.source_kind==='source_document'&&(typeof item.source_content_sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.source_content_sha256)))return null;
    rows.push(Object.fromEntries(names.map(name=>[name,item[name]])));
  }
  if(!rows.length)return null;
  try{return digest(rows.sort((a,b)=>String(a.source_ref_id)<String(b.source_ref_id)?-1:String(a.source_ref_id)>String(b.source_ref_id)?1:0));}catch{return null;}
}
const object=(value:unknown,keys:string[]):Record<string,any>=>{
  if(value===null||typeof value!=='object'||Array.isArray(value))fail();
  const result=value as Record<string,any>;
  if(Object.keys(result).sort().join(',')!==keys.slice().sort().join(','))fail();return result;
};
function span(raw:unknown,source:boolean):ProofSpan{
  const value=object(raw,source?['start','end','message_id']:['start','end']);
  if(!Number.isSafeInteger(value.start)||!Number.isSafeInteger(value.end)||value.start<0||value.start>=value.end||value.end>4096)fail('证明位置必须为有界整数区间。');
  const result:ProofSpan={start:value.start,end:value.end};
  if(source){
    if(typeof value.message_id!=='string')fail('证明来源必须为消息UUID。');
    const normalized=uuid(value.message_id);if(normalized!==value.message_id)fail('有限证明UUID必须使用规范表示。');
    result.message_id=normalized;
  }
  return result as ProofSpan;
}
function rule(raw:unknown):string{
  if(typeof raw!=='string'||!Object.hasOwn(VARIANTS,raw))fail('证明规则不在已批准集合。');return raw as string;
}
function links<T>(raw:unknown,maximum:number,parse:(value:unknown)=>T):T[]|null{
  if(raw===null)return null;
  if(!Array.isArray(raw)||raw.length>maximum)fail('证明链接超出有界集合。');
  const result=(raw as unknown[]).map(parse);if(new Set(result.map(value=>canonicalJSON(value))).size!==result.length)fail('有限证明链接不能重复。');return result;
}
export function parseProofProposal(raw:unknown):ProofProposal|null{
  if(raw===null||raw===undefined)return null;
  const value=object(raw,['version','atom_links','reference','reported']);
  if(value.version!==3||typeof value.version!=='number')fail('有限提案版本无效。');
  const atom_links=links(value.atom_links,16,item=>{
    const link=object(item,['rule_id','variant_id','source','candidate']),rule_id=rule(link.rule_id);
    if(typeof link.variant_id!=='string'||!VARIANTS[rule_id]!.includes(link.variant_id))fail('有限提案变体无效。');
    return {rule_id,variant_id:link.variant_id,source:span(link.source,true),candidate:span(link.candidate,false)};
  });
  const reference=links(value.reference,8,item=>{
    const link=object(item,['rule_id','mention','target','binding']),rule_id=rule(link.rule_id);
    return {rule_id,mention:span(link.mention,true),target:span(link.target,true),binding:link.binding===null?null:span(link.binding,true)};
  });
  const reported=links(value.reported,8,item=>{
    const link=object(item,['rule_id','frame','source','candidate']),rule_id=rule(link.rule_id);
    if(typeof link.frame!=='string'||!FRAMES.has(link.frame))fail('有限提案框架无效。');
    if((rule_id==='BR_REQUEST_V1')!==['reported_request','received_request'].includes(link.frame))fail('有限主规则与归属框架不符。');
    return {rule_id,frame:link.frame,source:span(link.source,true),candidate:span(link.candidate,false)};
  });
  const proposal:ProofProposal={version:3,atom_links,reference,reported};
  validateProposalShape(proposal);return proposal;
}
function validateProposalShape(proposal:ProofProposal):void{
  const all=[...(proposal.atom_links??[]),...(proposal.reference??[]),...(proposal.reported??[])];
  const rules=new Set(all.map(link=>link.rule_id));
  if(rules.size>1)fail('有限证明只能选择一个主规则。');
  const variants=new Set((proposal.atom_links??[]).map(link=>link.variant_id));
  if(variants.size>1)fail('有限证明只能选择一个变体。');
  for(const report of proposal.reported??[])if(report.rule_id==='BR_REQUEST_V1'&&variants.size
    &&[...variants][0]!.split('_')[0]!==report.frame.split('_')[0])fail('有限请托变体与归属框架不符。');
}
export function validateProofDomains(proposal:ProofProposal|null,window:ExtractionWindow,fact:ExtractedFact):void{
  if(!proposal)return;
  const messages=new Map(window.messages.map(message=>[uuid(message.message_id),message.text]));
  const sourceSpans=[...(proposal.atom_links??[]).map(link=>link.source),...(proposal.reported??[]).map(link=>link.source)];
  const candidateSpans=[...(proposal.atom_links??[]).map(link=>link.candidate),...(proposal.reported??[]).map(link=>link.candidate)];
  for(const link of proposal.reference??[]){
    sourceSpans.push(link.mention,link.target);if(link.binding)sourceSpans.push(link.binding);
  }
  for(const item of sourceSpans){
    const text=messages.get(item.message_id!);
    if(!text||!fact.source_message_ids.includes(item.message_id!)||item.end>length(text))fail('证明区间不属于实际候选来源。');
  }
  if(candidateSpans.some(item=>item.end>length(fact.text)))fail('证明区间超出实际候选。');
  for(const link of [...(proposal.atom_links??[]),...(proposal.reported??[])]){
    if(!window.target_message_ids?.includes(link.source.message_id!))fail('有限事件提案必须属于实际目标。');
  }
}
const variant=(basis:Evidence):string=>{
  const rule=basis.rules[0].rule_id;
  if(rule==='BR_AUTHOR_ARRIVAL_V1')return 'direct_quote';
  if(rule==='BR_COMPLETED_QA_V1')return 'completed_answer';
  if(rule==='BR_COND_RUN_V1')return 'conditional_plan';
  const binding=basis.reference_bindings.find((row:Evidence)=>row.method==='source_identity');
  const inline=binding?.binding?.message_id===basis.representation.target_message_id;
  const prefix=rule==='BR_REQUEST_V1'?(basis.frame==='reported_request'?'reported':'received')
    :basis.qualifiers.some((row:Evidence)=>row.kind==='polarity'&&row.value_sha256===digest(false))?'negative':'completed';
  return `${prefix}_${inline?'inline':'cross'}`;
};
function wholeMain(basis:Evidence):[Evidence,Evidence]{
  const sources=basis.representation.quote_sources;
  return [
    {message_id:sources[0].message_id,span:{start:sources[0].span.start,end:sources.at(-1).span.end}},
    basis.representation.quote,
  ];
}
function proposalMatches(proposal:ProofProposal,basis:Evidence,texts:ReadonlyMap<string,string>,candidateText:string):boolean{
  const expectedPosition=(raw:Evidence):[string|null,number,number]=>'span' in raw
    ?[raw.message_id??null,raw.span.start,raw.span.end]:[null,raw.start,raw.end];
  const actualPosition=(raw:ProofSpan):[string|null,number,number]=>[raw.message_id??null,raw.start,raw.end];
  const covers=(actual:ProofSpan,expected:Evidence,text:string):boolean=>{
    const [id,start,end]=expectedPosition(expected),[actualId,actualStart,actualEnd]=actualPosition(actual);
    return id===actualId&&actualStart<=start&&start<end&&end<=actualEnd
      &&!Array.from(text.slice(actualStart,start)).join('').trim()
      &&!Array.from(text.slice(end,actualEnd)).join('').trim();
  };
  const rule=basis.rules[0].rule_id,vari=variant(basis);
  if((proposal.atom_links??[]).length!==basis.atoms.length||(proposal.reference??[]).length!==basis.reference_bindings.length
    ||(proposal.reported??[]).length!==1)return false;
  const remaining=[...(proposal.atom_links??[])];
  for(const atom of basis.atoms as Evidence[]){
    const matches=remaining.flatMap((link,index)=>link.rule_id===rule&&link.variant_id===vari
      &&covers(link.source,atom.source,texts.get(link.source.message_id!)??'')
      &&covers(link.candidate,atom.candidate,candidateText)?[index]:[]);
    if(matches.length!==1)return false;remaining.splice(matches[0]!,1);
  }
  const references=[...(proposal.reference??[])];
  for(const binding of basis.reference_bindings as Evidence[]){
    const matches=references.flatMap((link,index)=>link.rule_id===rule
      &&covers(link.mention,binding.mention,texts.get(link.mention.message_id!)??'')
      &&covers(link.target,binding.target,texts.get(link.target.message_id!)??'')
      &&(link.binding===null&&binding.binding===null||link.binding!==null&&binding.binding!==null
        &&covers(link.binding,binding.binding,texts.get(link.binding.message_id!)??''))?[index]:[]);
    if(matches.length!==1)return false;references.splice(matches[0]!,1);
  }
  const reported=proposal.reported![0]!,[source,candidate]=wholeMain(basis);
  return reported.rule_id===rule&&reported.frame===basis.frame
    &&actualPosition(reported.source).join('|')===expectedPosition(source).join('|')
    &&actualPosition(reported.candidate).join('|')===expectedPosition(candidate).join('|');
}

export function verifyBoundedProof(
  proposal:ProofProposal|null,window:ExtractionWindow,fact:ExtractedFact,trustedSources?:ReadonlyMap<string,string>,
):ProofVerification{
  validateProofDomains(proposal,window,fact);
  const targets=window.target_message_ids;
  if(!Array.isArray(targets)||!targets.length||new Set(targets.map(uuid)).size!==targets.length)fail('有限运行必须显式提供目标。');
  const rep=boundedRepresentation(window,fact);
  if(!rep)return {status:'unknown',reason:'unsupported_representation',semantic_basis:null};
  const expectedAuthor=rep.target.sender==='self'?'用户':'联系人';
  if(rep.author!==expectedAuthor||fact.subject!==rep.target.sender)return {status:'unsupported',reason:'known_author_difference',semantic_basis:null};
  if(proposal)for(const link of proposal.atom_links??[]){
    const start=rep.main[0]!.start,end=rep.main.at(-1)!.end;
    if(link.source.message_id!==rep.target.message_id||link.source.start<start||link.source.end>end
      ||link.candidate.start<rep.quote_start||link.candidate.end>rep.quote_end)fail('有限事件提案不属于实际主目标及引句。');
  }
  if(fact.source_dependency_mode!=='all')return {status:'unknown',reason:'dependency_mode_mismatch',semantic_basis:null};
  if(trustedSources&&(trustedSources.size!==window.messages.length||window.messages.some(message=>trustedSources.get(uuid(message.message_id))!==message.text)))
    return {status:'unknown',reason:'untrusted_source',semantic_basis:null};
  try{validateBoundedBodySources(window,fact);}catch{return {status:'unknown',reason:'body_source_mismatch',semantic_basis:null};}
  if(window.messages.length>4||length(fact.text)>4096||window.messages.some(message=>length(message.text)>4096)
    ||rep.contexts.length>4)return {status:'unknown',reason:'scope_not_supported',semantic_basis:null};
  if(window.messages.some(message=>(message as any).message_type!=='text'||message.text_representation!=='text'
    ||sourceStateDigest(message.source_snapshots??[] )===null))return {status:'unknown',reason:'untrusted_source',semantic_basis:null};
  const messages=boundedMessages(window);
  const texts=new Map(messages.map(message=>[message.message_id,message.text]));
  const candidate:Evidence={text_content:fact.text,category:fact.category,source_ids:fact.source_message_ids,
    alternatives:fact.alternatives,valid_at:fact.valid_at,invalid_at:fact.invalid_at};
  const evidence:Evidence={pragmatics:{speech_act:fact.speech_act,assertion_status:fact.assertion_status,figurative_type:fact.figurative_type}};
  const checked=boundedBasisResult(candidate,evidence,messages,rep);
  if(checked.status!=='verified')return {...checked,semantic_basis:null};
  if(!proposal)return {status:'unknown',reason:'missing_proof',semantic_basis:null};
  if(!proposalMatches(proposal,checked.basis,texts,fact.text))return {status:'unknown',reason:'proposal_not_matching',semantic_basis:null};
  return {status:'verified',reason:'verified',semantic_basis:checked.basis};
}
