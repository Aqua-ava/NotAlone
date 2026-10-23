/** 与Python自动保存共用无正文稳定身份抑制；调用方持有contact→owner事务锁。 */
import type pg from 'pg';
import {parseJson} from './host-json.ts';
import type {IncrementalProcessingRecord, NormalizedIncrementalMessage} from './sync-incremental-normalize.ts';

type Obj=Record<string,unknown>;
type Identity=readonly [string,string];
const object=(v:unknown):v is Obj=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const key=(pair:Identity):string=>`${pair[0]}:${pair[1]}`;
function recordIdentity(record:IncrementalProcessingRecord):Identity|null{
  const payload=parseJson(record.payload_json);
  if(!object(payload)||!object(payload.parsed))return null;
  const parsed=payload.parsed,event=object(parsed.message)?parsed.message:parsed;
  const identity=object(event.message_id)?event.message_id:event.id;
  if(!object(identity))return null;
  // 十进制整数无损解码；缺失时间沿稳定身份约定使用-1，不猜测缺失ID。
  const integer=(value:unknown):bigint|null=>{
    if(typeof value==='bigint')return value;
    if(typeof value==='number'&&Number.isSafeInteger(value))return BigInt(value);
    if(typeof value==='string'&&/^-?(?:0|[1-9][0-9]*)$/.test(value))return BigInt(value);
    return null;
  };
  const id=integer(identity.local_id),time=event.create_time==null?-1n:integer(event.create_time);
  if(id===null||id<=0n||time===null)return null;
  return [id.toString(),time.toString()];
}
export async function filterAutoRead(c:pg.Client,owner:string,contact:string,
  messages:readonly NormalizedIncrementalMessage[],records:readonly IncrementalProcessingRecord[]){
  const messageKeys=messages.map(m=>[m.wechat_metadata.external_local_id,String(m.wechat_metadata.source_create_time??-1)] as const);
  const recordKeys=records.map(recordIdentity);
  const candidates=new Map<string,Identity>();
  for(const pair of [...messageKeys,...recordKeys])if(pair)candidates.set(key(pair),pair);
  if(!candidates.size)return {messages,records};
  const pairs=[...candidates.values()];
  const rows=await c.query(`SELECT s.external_local_id,s.identity_create_time
    FROM unnest($1::bigint[],$2::bigint[]) AS candidate(local_id,create_time)
    JOIN public.wechat_auto_read_suppression s
      ON s.external_local_id=candidate.local_id AND s.identity_create_time=candidate.create_time
      AND s.owner_id=$3 AND s.contact_id=$4`,[pairs.map(p=>p[0]),pairs.map(p=>p[1]),owner,contact]);
  const blocked=new Set(rows.rows.map(r=>key([String(r.external_local_id),String(r.identity_create_time)])));
  const captureIds=new Set<string>();
  const kept=messages.filter((m,index)=>{
    const deny=blocked.has(key(messageKeys[index]));
    if(deny)captureIds.add(m.processing_record.record_id);
    return !deny;
  });
  const safe=records.filter((r,index)=>!captureIds.has(r.record_id)&&
    (recordKeys[index]===null||!blocked.has(key(recordKeys[index]!))));
  return {messages:kept,records:safe};
}
