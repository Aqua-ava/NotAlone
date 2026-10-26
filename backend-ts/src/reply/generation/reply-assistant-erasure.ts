import {captureAssistantRuntimeDependencies} from '../runtime/assistant-runtime-erasure.ts';
/** 来源删除前验证真实助手父边并清除准备/恢复副本；调用方持有 owner 事务锁。 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import * as sql from './reply-assistant-erasure-sql.ts';
export class AssistantErasureError extends Error {
  readonly code = 'assistant_erasure_identity_invalid';
  constructor() {super('助手来源身份未可靠复验，删除事务必须回滚。');}
}
type Row = Record<string, any>;
const reject = (): never => {throw new AssistantErasureError();};
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashPattern=/^[0-9a-f]{64}$/;
function id(value: unknown): string {if(typeof value!=='string'||!idPattern.test(value))reject();return value as string;}
function object(value: unknown): value is Row {return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function sameKeys(value: unknown, fields: string[]): boolean {return object(value)&&Object.keys(value).sort().join('|')===fields.sort().join('|');}
function ids(values: unknown): string[] {if(!Array.isArray(values))reject();return (values as unknown[]).map(id);}
function sorted(values: Iterable<string>): string[] {return [...new Set(values)].sort();}
class LegacyNumber {
  readonly encoded: string;
  constructor(source: string) {
    if(!/[.eE]/.test(source)){this.encoded=BigInt(source).toString();return;}
    const n=Number(source);if(!Number.isFinite(n))reject();
    if(Object.is(n,-0)){this.encoded='-0.0';return;}
    const absolute=Math.abs(n);
    if(absolute!==0&&(absolute<1e-4||absolute>=1e16)) {
      const [coefficient,power]=n.toExponential().split('e');
      const exponent=Number(power);
      this.encoded=coefficient+'e'+(exponent<0?'-':'+')+String(Math.abs(exponent)).padStart(2,'0');
    } else {this.encoded=String(n)+(Number.isInteger(n)?'.0':'');}
  }
}
export function legacyJson(text:string|null):any {
  if(text===null)return null;
  return (JSON.parse as any)(text,(_key:string,value:unknown,context?:{source:string})=>{
    if(typeof value==='number'&&context?.source&&(/[.eE]/.test(context.source)||!Number.isSafeInteger(value)))return new LegacyNumber(context.source);
    return value;
  });
}
export function canonical(value: unknown): string {
  if(value instanceof LegacyNumber)return value.encoded;
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort((a,b)=>{const x=[...a],y=[...b];for(let i=0;i<Math.min(x.length,y.length);i++){const d=x[i].codePointAt(0)!-y[i].codePointAt(0)!;if(d)return d;}return x.length-y.length;}).map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isSafeInteger(value))return JSON.stringify(value);
  // 无法可靠编码的值不允许生成一个猜测的旧摘要。
  return reject();
}
export function fingerprint(value: unknown): string {return createHash('sha256').update(canonical(value)).digest('hex');}
function messages(value: unknown): Row[] {
  if(!Array.isArray(value)||value.length<1||value.length>8)reject();
  const result=(value as unknown[]).map(m=>{if(!sameKeys(m,['message_id','text'])||typeof (m as Row).text!=='string'||!(m as Row).text.trim())reject();return {message_id:id((m as Row).message_id),text:(m as Row).text};});
  if(new Set(result.map(m=>m.message_id)).size!==result.length)reject();return result;
}
interface CarryEdge {child:string;parent:string;contact:string;binding:string}
export async function carryEdges(client: pg.Client,owner:string,carryId:string|null=null):Promise<CarryEdge[]> {
  const edges:CarryEdge[]=[];
  const fields=['origin_owner_id','origin_contact_id','origin_binding_id','origin_session_id','origin_input_version_id','origin_turn_id','origin_reply_request_id','origin_candidate_id','origin_version_id','origin_selection_id'];
  for(const row of (await client.query(sql.carryRows.replace('session_id, content ','session_id, content::text AS content_text ').replace('ORDER BY id','AND ($2::uuid IS NULL OR id=$2) ORDER BY id'),[owner,carryId])).rows) {
    let p=legacyJson(row.content_text);
    if(object(p)&&p.metadata_version===1&&Array.isArray(p.style_sample_ids)&&p.style_sample_ids.length===0){p={...p,metadata_version:2};delete p.style_sample_ids;}
    if(!sameKeys(p,['type','metadata_version',...fields,'payload_sha256'])||p.type!=='candidate_carry'||p.metadata_version!==2||!hashPattern.test(p.payload_sha256))reject();
    for(const key of fields)id(p[key]);
    if(p.origin_owner_id!==owner||p.origin_contact_id!==row.contact_id||p.origin_binding_id!==row.conversation_binding_id||p.origin_session_id===row.session_id||p.origin_input_version_id===row.id)reject();
    const parent=(await client.query(sql.carryParent,fields.map(k=>p[k]))).rows[0];
    if(!parent||fingerprint(messages(parent.message_group))!==p.payload_sha256)reject();
    edges.push({child:row.id,parent:p.origin_input_version_id,contact:row.contact_id,binding:row.conversation_binding_id});
  }
  return edges;
}
export function snapshot(payload: unknown, owner:string,contact:string,key:string): Row {
  const fields=['version','scope','session_id','request_key','current_input_version_id','current_turn_id','current_payload_sha256','records'];
  if(!sameKeys(payload,fields)&&!sameKeys(payload,[...fields,'basis_revision_sha256']))reject();
  const p=payload as Row;
  if(p.version!==1||!sameKeys(p.scope,['owner_id','contact_id'])||p.scope.owner_id!==owner||p.scope.contact_id!==contact||p.request_key!==key||!hashPattern.test(p.current_payload_sha256)||p.basis_revision_sha256!==undefined&&!hashPattern.test(p.basis_revision_sha256)||!Array.isArray(p.records))reject();
  for(const k of ['session_id','request_key','current_input_version_id','current_turn_id'])id(p[k]);
  const seen=new Set();
  for(const r of p.records) {
    if(!sameKeys(r,['kind','input_version_id','payload_sha256','turn_id','candidate_id','version_id'])||!hashPattern.test(r.payload_sha256))reject();
    id(r.input_version_id);for(const k of ['turn_id','candidate_id','version_id'])if(r[k]!==null)id(r[k]);
    if(r.kind==='discussion_input'){if(r.turn_id!==null||r.candidate_id!==null||r.version_id!==null)reject();}
    else if(r.kind==='generation_input'){if(r.turn_id===null||r.candidate_id!==null||r.version_id!==null)reject();}
    else if(r.kind==='candidate_version'){if(r.turn_id===null||r.candidate_id===null||r.version_id===null)reject();}else reject();
    const identity=r.kind+':'+(r.kind==='candidate_version'?r.version_id:r.input_version_id);
    if(seen.has(identity)||r.input_version_id===p.current_input_version_id||r.turn_id===p.current_turn_id)reject();seen.add(identity);
  }
  return p;
}
export async function inputRows(client:pg.Client,owner:string,contact:string,session:string):Promise<Row[]> {
  return (await client.query(`SELECT input.id,input.session_id,input.turn_id,input.input_type,input.state,input.content::text AS content_text,input.conversation_binding_id,input.dependency_ids,
    turn.state AS turn_state,turn.input_payload::text AS input_payload_text,turn.input_digest,turn.dependency_ids AS turn_dependencies,request.id AS reply_request_id,request.state AS request_state
    FROM assistant_session_input input LEFT JOIN assistant_session_turn turn ON turn.id=input.turn_id AND turn.input_version_id=input.id AND turn.owner_id=input.owner_id AND turn.contact_id=input.contact_id AND turn.session_id=input.session_id
    LEFT JOIN reply_request request ON(turn.reply_request_id IS NULL OR request.id=turn.reply_request_id) AND request.owner_id=turn.owner_id AND request.contact_id=turn.contact_id AND request.conversation_binding_id=turn.conversation_binding_id AND request.idempotency_key=turn.idempotency_key
    WHERE input.owner_id=$1 AND input.contact_id=$2 AND input.session_id=$3 ORDER BY input.created_at,coalesce(input.turn_id,input.id)`,[owner,contact,session])).rows.map(row=>({...row,content:legacyJson(row.content_text),input_payload:legacyJson(row.input_payload_text)}));
}
async function requireGeneration(client:pg.Client,owner:string,contact:string,row:Row):Promise<void> {
  if(row.input_type!=='generation'||row.state!=='active'||!['running','failed','completed'].includes(row.turn_state)||row.input_payload===null||row.input_digest===null)reject();
  const actual=(await client.query(sql.generation,[owner,contact,row.session_id,row.turn_id,row.id,row.conversation_binding_id])).rows[0];
  if(!actual||actual.request_id!==row.reply_request_id||row.turn_state==='completed'&&actual.request_id===null||actual.reply_request_id!==null&&actual.request_id===null)reject();
}
export const activeMessage=`EXISTS(SELECT 1 FROM message_source_ref ref WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND (ref.observation_id IS NOT NULL OR EXISTS(SELECT 1 FROM source_document source WHERE source.id=ref.source_document_id AND source.owner_id=ref.owner_id AND source.contact_id=ref.contact_id AND source.status='active')))`;
async function requireActiveSources(client:pg.Client,owner:string,sources:string[]):Promise<void> {
  if(!sources.length)return;
  const rows=(await client.query(`SELECT id FROM source_document WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status='active' UNION SELECT id FROM local_wechat_observation WHERE owner_id=$1 AND id=ANY($2::uuid[]) UNION SELECT id FROM message WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND ${activeMessage}`,[owner,sources])).rows;
  if(rows.length!==new Set(sources).size)reject();
}
export async function evidenceSources(client:pg.Client,owner:string,e:Row,strictOwner=false,qualification?:{historical:boolean;text?:string}):Promise<string[]> {
  const sources=ids(e.source_ids);
  if(e.kind!=='owner_memory'||!sources.includes(owner)&&!strictOwner)return sources;
  let row=(await client.query('SELECT * FROM owner_memory WHERE owner_id=$1 AND id=$2',[owner,id(e.evidence_id)])).rows[0];
  if(!row||!['active','invalidated'].includes(row.status)||canonical(sorted(row.source_ids))!==canonical(sorted(sources)))reject();
  if(qualification&&(!qualification.historical&&row.status!=='active'||qualification.text!==undefined&&row.text_content!==qualification.text))reject();
  if(row.source_dependency_mode==='all') {
    const rows=(await client.query(`SELECT message.id,message.contact_id FROM message WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND ${activeMessage} FOR SHARE OF message`,[owner,sources])).rows;
    if(!sources.length||new Set(sources).size!==sources.length||rows.length!==sources.length||new Set(rows.map(r=>r.contact_id)).size!==1)reject();
    return sources;
  }
  if(row.source_dependency_mode!==null&&row.source_dependency_mode!==undefined&&row.source_dependency_mode!=='any')reject();
  if(!sources.includes(owner)){await requireActiveSources(client,owner,sources);return sources;}
  const visited=new Set();
  for(let i=0;i<100;i++) {
    if(!row||visited.has(row.id)||row.owner_id!==owner||row.status==='deleted'||row.adoption_method!=='manual'||!row.source_ids.includes(owner))reject();
    visited.add(row.id);
    if(row.supersedes_memory_id===null){if(row.source_candidate_id!==null||row.source_ids.length!==1)reject();const actual=sources.filter(x=>x!==owner);await requireActiveSources(client,owner,actual);return actual;}
    row=(await client.query('SELECT * FROM owner_memory WHERE owner_id=$1 AND id=$2',[owner,row.supersedes_memory_id])).rows[0];
  }
  return reject();
}
export async function generationDependencies(client:pg.Client,owner:string,contact:string,row:Row):Promise<string[]> {
  const dependencies=new Set<string>(ids(row.turn_dependencies??[]));
  if(row.reply_request_id===null)return sorted(dependencies);
  // 祖先材料与原始来源在同一只读语句批取；无证据行时仍读取当前请求的原始来源。
  const batch=(await client.query(`WITH dependency_rows AS (${sql.replyDependencies})
    SELECT coalesce((SELECT jsonb_agg(to_jsonb(dependency)) FROM dependency_rows dependency),'[]'::jsonb) AS dependencies,
    ARRAY(SELECT source_id FROM reply_original_source_use WHERE owner_id=$1 AND reply_request_id IN
      (SELECT request_id FROM dependency_rows UNION SELECT $3::uuid)) AS source_ids`,[owner,contact,row.reply_request_id,owner,contact,owner,contact])).rows[0];
  const rows:Row[]=batch.dependencies;
  const used=new Set<string>();
  const snapshots=new Map<string,Row>();
  function actual(value:unknown):void {if(Array.isArray(value)){for(const v of value)actual(v);}else if(object(value))for(const [k,v] of Object.entries(value)){if(k==='evolution')continue;if(['memory_id','evidence_id'].includes(k)&&typeof v==='string'&&idPattern.test(v))used.add(v);actual(v);}}
  for(const item of rows){for(const e of item.evidence)used.add(id(e.evidence_id));for(const d of ids(item.dependency_ids??[]))used.add(d);snapshots.set(item.request_id,item.context_snapshot??{});}
  for(const value of snapshots.values())actual(value);
  for(const value of snapshots.values()) {
    const provenance=new Set<string>();
    if(!Array.isArray(value.evidence??[])||!Array.isArray(value.navigation_dependency_ids??[]))reject();
    for(const e of value.evidence??[]) {const evolution=e.evolution??{};for(const r of evolution.related_versions??[])provenance.add(id(r.memory_id));for(const d of ids(evolution.evidence_message_ids??[]))dependencies.add(d);}
    for(const d of ids(value.navigation_dependency_ids??[]))if(!provenance.has(d)||used.has(d))dependencies.add(d);
  }
  for(const item of rows) {
    for(const d of ids(item.dependency_ids??[]))dependencies.add(d);
    for(const e of item.evidence) {for(const d of await evidenceSources(client,owner,e))dependencies.add(d);if(!['user_draft','user_current_chat','user_purpose','continued_candidate'].includes(e.kind))dependencies.add(id(e.evidence_id));}
  }
  for(const source of batch.source_ids)dependencies.add(source);
  return sorted(dependencies);
}
async function candidateHash(client:pg.Client,owner:string,contact:string,row:Row,identity:Row):Promise<string> {
  if(row.turn_state!=='completed'||row.request_state!=='completed')reject();
  const c=(await client.query(sql.candidate,[row.turn_id,identity.version_id,row.session_id,row.turn_id,owner,contact,identity.candidate_id,row.reply_request_id,row.conversation_binding_id,identity.version_id])).rows[0];
  if(!c)reject();
  let version=(await client.query('SELECT * FROM assistant_candidate_version WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND candidate_id=$4 AND id=$5',[owner,contact,row.session_id,c.id,identity.version_id])).rows[0];
  if(!version&&identity.version_id===c.id)version={id:c.id,version_number:0,parent_version_id:null,requirements:null};
  if(!version)reject();
  const group=messages(version.version_number===0?c.message_group:version.message_group);
  return fingerprint([canonical({messages:group,requirements:version.requirements}),version.version_number,version.parent_version_id,c.reply_request_id,c.ordinal+1]);
}
export async function capturedEdges(client:pg.Client,owner:string,requestId:string|null=null,providedSnapshot?:Row):Promise<{child:string;parent:string}[]> {
  const edges:{child:string;parent:string}[]=[];
  const requests=(await client.query("SELECT id,contact_id,idempotency_key,conversation_binding_id,context_snapshot FROM reply_request WHERE owner_id=$1 AND ($2::uuid IS NULL OR id=$2) AND (context_snapshot ? 'assistant_discussion_snapshot' OR $3) ORDER BY id",[owner,requestId,providedSnapshot!==undefined])).rows;
  for(const request of requests) {
    const contact=request.contact_id,p=providedSnapshot?{...(request.context_snapshot??{}),assistant_discussion_snapshot:providedSnapshot}:request.context_snapshot;
    if(p.scope!==undefined&&canonical(p.scope)!==canonical({owner_id:owner,contact_id:contact}))reject();
    const snap=snapshot(p.assistant_discussion_snapshot,owner,contact,request.idempotency_key);
    const anchor=(await client.query(sql.anchor.replace('turn.input_payload,','turn.input_payload::text AS input_payload_text,'),[owner,contact,request.idempotency_key])).rows[0];
    if(anchor)anchor.input_payload=legacyJson(anchor.input_payload_text);
    const rows=new Map((await inputRows(client,owner,contact,snap.session_id)).map(r=>[r.id,r]));
    const current=rows.get(snap.current_input_version_id);
    if(!anchor||!current||request.conversation_binding_id!==anchor.conversation_binding_id||anchor.anchor_binding_id!==anchor.conversation_binding_id||current.reply_request_id!==request.id||anchor.session_id!==snap.session_id||anchor.input_version_id!==snap.current_input_version_id||anchor.id!==snap.current_turn_id||fingerprint([anchor.input_digest,anchor.input_payload,anchor.conversation_binding_id])!==snap.current_payload_sha256)reject();
    await requireGeneration(client,owner,contact,current!);
    for(const r of snap.records) {
      const row=rows.get(r.input_version_id);if(!row||row.state!=='active')reject();let hash;
      if(r.kind==='discussion_input') {if(row!.input_type==='generation'||row!.turn_id!==null||row!.content===null)reject();hash=fingerprint([row!.content,row!.conversation_binding_id,sorted(ids(row!.dependency_ids))]);}
      else {if(r.turn_id!==row!.turn_id)reject();await requireGeneration(client,owner,contact,row!);hash=r.kind==='generation_input'?fingerprint([row!.input_payload,row!.input_digest,row!.conversation_binding_id,row!.reply_request_id,await generationDependencies(client,owner,contact,row!),[]]):await candidateHash(client,owner,contact,row!,r);}
      if(hash!==r.payload_sha256)reject();edges.push({child:snap.current_input_version_id,parent:r.input_version_id});
    }
  }
  return edges;
}
export interface AssistantErasurePorts {
  eraseSkillLearning(client:pg.Client,owner:string,removedIds:string[]):Promise<void>;
}
/** 与09 ErasurePorts四参合同一致；06清理递归在擦除A/C捕获身份之前执行。 */
export function createAssistantErasure(ports:AssistantErasurePorts) {
  if(typeof ports?.eraseSkillLearning!=='function')reject();
  return async function eraseAssistantDependencies(client:pg.Client,owner:string,removedIds:string[],requestIds:string[]):Promise<string[]> {
    id(owner);ids(removedIds);ids(requestIds);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
    const carry=await carryEdges(client,owner),captured=await capturedEdges(client,owner);
    const explicit=(await client.query(sql.selectedSkills,[owner,removedIds])).rows.map(r=>r.id);
    const initial=(await client.query(sql.sourceTurns,[owner,removedIds,requestIds,explicit,null,null])).rows;
    const independent=(row:Row,turns:Set<string>)=>!turns.has(row.id)&&row.request_state==='running'&&!row.dependency_ids.some((x:string)=>removedIds.includes(x))&&object(row.input_payload)&&row.input_payload.content?.type==='rewrite_draft'&&!row.input_payload.content.include_relationship_context&&row.input_payload.continued_from_candidate_id==null&&!object(row.input_payload.continuation);
    const excluded=new Set(initial.filter(r=>independent(r,new Set(explicit))).map(r=>r.request_id));
    const selected=(await client.query(sql.lineage,[owner,removedIds,requestIds.filter(r=>!excluded.has(r)),explicit,null,JSON.stringify(carry),JSON.stringify(captured)])).rows;
    const turns=sorted([...explicit,...selected.map(r=>r.turn_id).filter(Boolean)]), inputs=selected.map(r=>r.id);
    const requests=sorted([...requestIds,...selected.map(r=>r.request_id).filter(Boolean)]);
    await captureAssistantRuntimeDependencies(client,owner,turns,requests,inputs);
    // 学习/发布可能递归进入回复删除；边已经完整预捕获，不重新读取被清空的身份。
    await ports.eraseSkillLearning(client,owner,sorted([...removedIds,...requests,...turns,...inputs]));
    const rows=(await client.query(sql.sourceTurns,[owner,removedIds,requests,turns,null,null])).rows;
    for(const row of rows) {
      if(independent(row,new Set(turns)))await client.query("UPDATE assistant_session_turn SET state='failed',reply_request_id=NULL,updated_at=now() WHERE id=$1",[row.id]);
      else await client.query("UPDATE assistant_session_turn SET state='redacted',input_payload=NULL,input_digest=NULL,reply_request_id=NULL,dependency_ids='{}',updated_at=now() WHERE id=$1",[row.id]);
    }
    await client.query(sql.eraseInputs,[owner,inputs,removedIds]);
    return requests;
  };
}
