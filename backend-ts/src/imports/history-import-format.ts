/** 微信单联系人 JSONL 的确定性读取、范围校验与规范化。 */
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';

export const MAX_IMPORT_BYTES=64*1024*1024;
export const MAX_IMPORT_RECORDS=500_000;

export type HistoryMessageKind='text'|'quote'|'image'|'sticker'|'transfer'|'system'|'voice'|'voip'|'video'|'channel_video'|'file'|'link'|'location'|'miniprogram'|'card'|'red_packet'|'forward_chat'|'app';
export interface HistoryIdentity {externalId:string;observedName:string;observedNameVariantCount:number}
export interface NormalizedHistoryMessage {
  sourceLocator:string;
  speaker:'user'|'contact'|'system';
  messageType:HistoryMessageKind;
  textContent:string;
  mediaPlaceholder:string|null;
  occurredAt:string;
  externalLocalId:number;
  externalServerId:string;
  externalTalker:string;
  sourceCreateTime:number;
  rawPayload:Record<string,unknown>;
  recordText:string;
}
export interface ParsedHistoryImport {
  fileName:string;
  contentSha256:string;
  ownerIdentity:HistoryIdentity;
  contactIdentity:HistoryIdentity;
  messages:NormalizedHistoryMessage[];
  kindCounts:Record<string,number>;
}
export class HistoryImportFormatError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.code=code;this.name='HistoryImportFormatError';}
}

const supportedKinds=new Set<HistoryMessageKind>(['text','quote','image','sticker','transfer','system','voice','voip','video','channel_video','file','link','location','miniprogram','card','red_packet','forward_chat','app']);
const mediaKinds=new Set<HistoryMessageKind>(['image','sticker','voice','voip','video','channel_video','file','link','location','miniprogram','card','red_packet','forward_chat','app']);
const requiredFields=['id','create_time','is_from_me','kind','sender','text','time','time_iso'] as const;
const requiredIdFields=['local_id','server_id_str','talker'] as const;
const bigintMin=-(2n**63n),bigintMax=2n**63n-1n;
const fail=(code:string):never=>{throw new HistoryImportFormatError(code);};
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const nonEmpty=(value:unknown):string|null=>typeof value==='string'&&value.trim()?value.trim():null;
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);

async function readBounded(path:string):Promise<Buffer>{
  let file;
  try{
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    if(!(await file.stat()).isFile())fail('file_unavailable');
    const chunks:Buffer[]=[];let size=0;
    while(size<=MAX_IMPORT_BYTES){
      const chunk=Buffer.allocUnsafe(Math.min(64*1024,MAX_IMPORT_BYTES+1-size));
      const {bytesRead}=await file.read(chunk,0,chunk.length,size);
      if(!bytesRead)break;
      chunks.push(chunk.subarray(0,bytesRead));size+=bytesRead;
    }
    if(size>MAX_IMPORT_BYTES)fail('file_size_limit');
    return Buffer.concat(chunks,size);
  }catch(error){
    if(error instanceof HistoryImportFormatError)throw error;
    throw new HistoryImportFormatError('file_unavailable');
  }finally{await file?.close();}
}

function recordsFrom(text:string):{record:Record<string,unknown>;line:string;lineNumber:number}[]{
  const lines=text.match(/[^\n]*\n|[^\n]+$/g)??[];
  if(!lines.length)fail('empty_document');
  if(lines.length>MAX_IMPORT_RECORDS)fail('record_count_limit');
  return lines.map((line,index)=>{
    if(!line.trim())fail('empty_line');
    let parsed:unknown;
    try{parsed=JSON.parse(line);}catch{fail('invalid_json');}
    if(!object(parsed))fail('non_object_record');
    return {record:parsed as Record<string,unknown>,line,lineNumber:index+1};
  });
}

function latestIdentity(rows:{createTime:number;lineNumber:number;name:string}[]):HistoryIdentity{
  const latest=[...rows].sort((a,b)=>b.createTime-a.createTime||b.lineNumber-a.lineNumber)[0]!;
  return {externalId:'',observedName:latest.name,observedNameVariantCount:new Set(rows.map(row=>row.name)).size};
}

function parsedTimestamp(value:string):number|null{
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match)return null;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]??'0');
  if(year<1||month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()
    ||hour>23||minute>59||second>59)return null;
  if(match[7]!=='Z'){
    const offset=/^[+-](\d{2}):(\d{2})$/.exec(match[7]);
    if(!offset||Number(offset[1])>23||Number(offset[2])>59)return null;
  }
  const timestamp=Date.parse(value);
  return Number.isFinite(timestamp)?timestamp:null;
}

function validateRecord(record:Record<string,unknown>,lineNumber:number,keys:Set<string>):void{
  if(requiredFields.some(field=>!(field in record)))fail('required_field_missing');
  const idValue=record.id;
  if(!object(idValue))fail('field_type_invalid');
  const id=idValue as Record<string,unknown>;
  if(requiredIdFields.some(field=>!(field in id)))fail('required_field_missing');
  const localId=id.local_id,createTime=record.create_time;
  if(!integer(localId)||!integer(createTime))fail('field_type_invalid');
  const safeLocalId=localId as number,safeCreateTime=createTime as number;
  if(BigInt(safeLocalId)<bigintMin||BigInt(safeLocalId)>bigintMax||BigInt(safeCreateTime)<bigintMin||BigInt(safeCreateTime)>bigintMax)fail('numeric_out_of_range');
  const key=`${safeLocalId}:${safeCreateTime}`;
  if(keys.has(key))fail('message_key_duplicate');
  keys.add(key);
  if(!nonEmpty(id.server_id_str)||!nonEmpty(id.talker))fail('field_value_empty');
  if(typeof record.is_from_me!=='boolean')fail('field_type_invalid');
  if(typeof record.kind!=='string'||!supportedKinds.has(record.kind as HistoryMessageKind))fail('message_kind_unsupported');
  for(const field of ['sender','text','time','time_iso'])if(typeof record[field]!=='string')fail('field_type_invalid');
  for(const field of ['sender','text','time'])if(!nonEmpty(record[field]))fail('field_value_empty');
  const time=String(record.time_iso);
  const timestamp=parsedTimestamp(time);
  if(timestamp===null)throw new HistoryImportFormatError('timestamp_invalid');
  if(timestamp%1000!==0||timestamp/1000!==record.create_time)fail('timestamp_inconsistent');
  const kind=record.kind as HistoryMessageKind;
  if(kind==='image'&&record.images!==undefined){
    const images=record.images;
    if(!Array.isArray(images))fail('field_type_invalid');
    if((images as unknown[]).some(image=>!object(image)||('path' in image&&typeof image.path!=='string')))fail('field_type_invalid');
  }
  if(kind==='quote'&&record.quote!==undefined&&!object(record.quote))fail('field_type_invalid');
  if(kind==='transfer'&&record.transfer!==undefined&&!object(record.transfer))fail('field_type_invalid');
}

function normalizeMessage(record:Record<string,unknown>,lineNumber:number,line:string):NormalizedHistoryMessage{
  const id=record.id as Record<string,unknown>;
  const kind=record.kind as HistoryMessageKind;
  const media=mediaKinds.has(kind);
  return {
    sourceLocator:`jsonl:${lineNumber}`,
    speaker:kind==='system'?'system':record.is_from_me===true?'user':'contact',
    messageType:kind,
    textContent:media?'':String(record.text),
    mediaPlaceholder:media?String(record.text):null,
    occurredAt:String(record.time_iso),
    externalLocalId:id.local_id as number,
    externalServerId:String(id.server_id_str).trim(),
    externalTalker:String(id.talker).trim(),
    sourceCreateTime:record.create_time as number,
    rawPayload:record,
    recordText:line,
  };
}

export async function parseHistoryImport(path:string):Promise<ParsedHistoryImport>{
  const content=await readBounded(path);
  let text='';
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{fail('invalid_utf8');}
  const records=recordsFrom(text);
  const keys=new Set<string>(),talkers=new Set<string>(),contactIds=new Set<string>(),ownerIds=new Set<string>();
  const contactNames:{createTime:number;lineNumber:number;name:string}[]=[];
  const ownerNames:{createTime:number;lineNumber:number;name:string}[]=[];
  const kindCounts:Record<string,number>={};
  for(const item of records){
    validateRecord(item.record,item.lineNumber,keys);
    const kind=item.record.kind as HistoryMessageKind,id=item.record.id as Record<string,unknown>;
    const talker=String(id.talker).trim();
    if(talker.endsWith('@chatroom'))fail('group_chat_unsupported');
    talkers.add(talker);kindCounts[kind]=(kindCounts[kind]??0)+1;
    if(kind!=='system'){
      const senderValue=nonEmpty(item.record.sender_wxid);
      if(senderValue===null)fail('sender_identity_missing');
      const senderId=senderValue as string;
      if(item.record.is_from_me===false){
        contactIds.add(senderId);
        contactNames.push({createTime:item.record.create_time as number,lineNumber:item.lineNumber,name:String(item.record.sender).trim()});
      }else{
        ownerIds.add(senderId);
        ownerNames.push({createTime:item.record.create_time as number,lineNumber:item.lineNumber,name:String(item.record.sender).trim()});
      }
    }
  }
  if(talkers.size!==1)fail('contact_scope_mixed');
  if(contactIds.size!==1)fail(contactIds.size?'contact_scope_mixed':'contact_identity_missing');
  if(ownerIds.size!==1)fail(ownerIds.size?'owner_scope_mixed':'owner_identity_missing');
  const contactExternalId=[...contactIds][0]!,ownerExternalId=[...ownerIds][0]!;
  if([...talkers][0]!==contactExternalId)fail('contact_identity_inconsistent');
  if(contactExternalId===ownerExternalId)fail('sender_identity_conflict');
  const ownerIdentity=latestIdentity(ownerNames),contactIdentity=latestIdentity(contactNames);
  ownerIdentity.externalId=ownerExternalId;contactIdentity.externalId=contactExternalId;
  return {fileName:basename(path),contentSha256:createHash('sha256').update(content).digest('hex'),
    ownerIdentity,contactIdentity,kindCounts,
    messages:records.map(item=>normalizeMessage(item.record,item.lineNumber,item.line))};
}
