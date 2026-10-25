/** 明确长期表达偏好管理；身份取自宿主，沿用原表及操作摘要。 */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {eraseManagedUpdateBackups,cleanupPreferenceFiles} from './preference-files.ts';
import {deleteSourceReplies,eraseSkillLearning,type ErasurePorts} from './preference-erasure.ts';
import type pg from 'pg';
import {HostStorage,HostStorageError} from './host-storage.ts';
export class PreferenceError extends HostStorageError {
 readonly status:number;
 constructor(kind='unavailable',status=503){super(kind==='method_not_allowed'?'method_not_allowed':`expression_preference_${kind}`);this.status=status;}
}
const fail=(kind:string,status:number):never=>{throw new PreferenceError(kind,status);};
const uuid=(value:unknown):string=>{
 if(typeof value!=='string')return fail('invalid',400);
 const normalized=value.replace(/^urn:uuid:/,'').replace(/[{}-]/g,'');
 if(!/^[a-f0-9]{32}$/i.test(normalized))return fail('invalid',400);
 return normalized.toLowerCase().replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');
};
const modes=new Set(['reply_to_message','rewrite_draft','initiate_conversation']);
function exact(value:any,keys:string[]):void{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.sort().join())fail('invalid',400);}
// Python str.strip的空白集合：包含U+0085/控制分隔符，不误删U+FEFF。
function text(value:unknown):string {
 if(typeof value!=='string')return fail('invalid',400);
 const normalized=value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
 if([...normalized].length<1||[...normalized].length>512)return fail('invalid',400);return normalized;
}
export type PreferenceRevision=number|bigint;
function validRevision(value:unknown,minimum=1):value is PreferenceRevision{return (typeof value==='bigint'||typeof value==='number'&&Number.isSafeInteger(value))&&value>=minimum;}
function revision(value:unknown):PreferenceRevision{if(!validRevision(value))return fail('invalid',400);return value;}
function persistedRevision(value:string|number|bigint):PreferenceRevision{const result=BigInt(value);return result<=BigInt(Number.MAX_SAFE_INTEGER)?Number(result):result;}
function pythonJson(value:unknown):string{return typeof value==='bigint'?value.toString():JSON.stringify(value);}
/** Python json.dumps(sort_keys=True) 默认ASCII转义与空格，兼容已持久化操作键。 */
function digest(value:Record<string,unknown>):string {
 const encoded='{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+': '+pythonJson(value[key])).join(', ')+'}';
 return createHash('sha256').update(encoded.replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))).digest('hex');
}
const columns=`*, to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00' AS confirmed_iso,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00' AS updated_iso`;
function payload(row:any):any {
 if(row.status!=='active')fail('deleted',410);
 const rev=persistedRevision(row.revision);
 return {preference_id:row.id,text:row.text_content,scope:{contact_id:row.contact_id,reply_mode:row.reply_mode},revision:rev,confirmed_operation_key:row.confirmed_operation_key,origin:row.origin_id?{kind:row.origin_kind,id:row.origin_id}:{kind:row.origin_kind},source_ids:row.source_ids,confirmed_at:row.confirmed_iso.replace('.000000+','+'),updated_at:row.updated_iso.replace('.000000+','+')};
}
export function preferenceRoute(_method:string,pathname:string):boolean{return /^\/api\/expression-preferences(?:\/[^/]+)?\/?$/.test(pathname);}
export async function lockPreferenceOwner(client:pg.Client,owner:string):Promise<void>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);}
async function scopeExists(client:pg.Client,owner:string,contact:string|null):Promise<void>{if(contact&&!(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',[owner,contact])).rowCount)fail('not_found',404);}
export async function bumpPreferenceRevision(client:pg.Client,owner:string):Promise<void>{await client.query('INSERT INTO public.expression_preference_state(owner_id,revision) VALUES($1,1) ON CONFLICT(owner_id) DO UPDATE SET revision=expression_preference_state.revision+1',[owner]);}
async function current(client:pg.Client,row:any):Promise<any>{
 const result=payload(row);
 if(row.source_ids.length&&(await client.query(`SELECT id FROM unnest($1::uuid[]) AS dependency(id) WHERE NOT EXISTS(
 SELECT 1 FROM public.source_document WHERE owner_id=$2 AND contact_id=$3 AND id=dependency.id AND status='active'
 UNION ALL SELECT 1 FROM public.local_wechat_observation WHERE owner_id=$2 AND contact_id=$3 AND id=dependency.id
 UNION ALL SELECT 1 FROM public.message_source_ref ref LEFT JOIN public.source_document s ON s.id=ref.source_document_id LEFT JOIN public.local_wechat_observation o ON o.id=ref.observation_id WHERE ref.owner_id=$2 AND ref.contact_id=$3 AND ref.message_id=dependency.id AND(s.status='active' OR o.id IS NOT NULL)) LIMIT 1`,[row.source_ids,row.owner_id,row.contact_id])).rowCount)fail('deleted',410);
 return result;
}
async function read(client:pg.Client,owner:string,id:string,contact:string|null):Promise<any>{const row=(await client.query(`SELECT ${columns} FROM public.expression_preference WHERE owner_id=$1 AND id=$2 AND(contact_id IS NULL OR contact_id=$3)`,[owner,id,contact])).rows[0];if(!row)fail('not_found',404);return row;}
export interface PreferenceDeletion {
 ports?:Partial<ErasurePorts>;
 eraseManagedBackups?:(client:pg.Client,environment:NodeJS.ProcessEnv)=>Promise<void>;
 cleanupFiles?:(storage:HostStorage,owner:string)=>Promise<void>;
}
export class PreferenceService {
 readonly storage:HostStorage;
 readonly deletion:PreferenceDeletion;
 constructor(storage:HostStorage,deletion:PreferenceDeletion={}){this.storage=storage;this.deletion=deletion;}
 async handle(method:string,url:URL,body?:any,assertCurrent:()=>void=()=>{}):Promise<any>{
  assertCurrent();if(!preferenceRoute(method,url.pathname))return fail('not_found',404);
  const owner=this.storage.runtimeOwnerId;if(!owner)fail('unavailable',503);
  const selected=url.searchParams.getAll('contact_id');if([...url.searchParams.keys()].some(k=>k!=='contact_id')||selected.length>1)fail('invalid',400);
  const contact=selected.length?uuid(selected[0]):null;
  const parts=url.pathname.replace(/\/$/,'').split('/');const id=parts[3]?uuid(parts[3]):null;
  if(!((method==='GET')||(method==='POST'&&!id)||(['PATCH','DELETE'].includes(method)&&id)))fail('method_not_allowed',405);
  let command:any;
  if(method!=='GET'){
   exact(body,method==='POST'?['operation_key','text','scope','origin','confirm_long_term']:method==='PATCH'?['operation_key','expected_revision','text','scope','confirm_long_term']:['operation_key','expected_revision']);
   command={operation:uuid(body.operation_key)};
   if(method!=='POST')command.expected=revision(body.expected_revision);
   if(method!=='DELETE'){
    if(body.confirm_long_term!==true)fail('invalid',400);exact(body.scope,['contact_id','reply_mode']);
    if(body.scope.reply_mode!==null&&!modes.has(body.scope.reply_mode))fail('invalid',400);
    command={...command,text:text(body.text),contact:body.scope.contact_id===null?null:uuid(body.scope.contact_id),mode:body.scope.reply_mode};
    if(method==='POST'){
     exact(body.origin,body.origin?.kind==='manual'?['kind']:['kind','id']);
     if(!['manual','message'].includes(body.origin.kind))fail('invalid',400);
     command.kind=body.origin.kind;command.origin=body.origin.kind==='manual'?null:uuid(body.origin.id);
     if(contact&&command.contact!==null&&command.contact!==contact)fail('invalid',400);
    }
   }
  }
  try{const result=await this.storage.businessTransaction(async client=>{
   await lockPreferenceOwner(client,owner!);assertCurrent();await scopeExists(client,owner!,contact);
   let result:any;
   if(method==='GET'){
    if(id)result={preference:await current(client,await read(client,owner!,id,contact))};
    else {const preferences=[];for(const row of (await client.query(`SELECT ${columns} FROM public.expression_preference WHERE owner_id=$1 AND(contact_id IS NULL OR contact_id=$2) AND status='active' ORDER BY confirmed_at,id`,[owner,contact])).rows){try{preferences.push(await current(client,row));}catch(e){if(!(e instanceof PreferenceError&&e.status===410))throw e;}}result={preferences};}
   }else if(method==='POST')result={preference:await this.save(client,owner!,contact,command)};
   else if(method==='PATCH')result={preference:await this.update(client,owner!,contact,id!,command)};
   else {await this.remove(client,owner!,contact,id!,command);result={state:'deleted'};}
   assertCurrent();return result;
  });if(method==='DELETE'){if(this.deletion.cleanupFiles)await this.deletion.cleanupFiles(this.storage,owner!);else await cleanupPreferenceFiles(this.storage,owner!);}return result;}catch(e){if(e instanceof PreferenceError)throw e;throw new PreferenceError();}
 }
 private async backups(client:pg.Client):Promise<void>{
  const env=this.storage.runtimeEnvironment();if(this.deletion.eraseManagedBackups){await this.deletion.eraseManagedBackups(client,env);return;}
  await eraseManagedUpdateBackups(client,env);
 }
 private async remove(client:pg.Client,owner:string,contact:string|null,id:string,c:any):Promise<void>{
  const hash=digest({preference_id:id,expected_revision:c.expected});
  const row=await read(client,owner,id,contact);
  const operation=(await client.query('SELECT * FROM public.expression_preference_operation WHERE owner_id=$1 AND operation_key=$2',[owner,c.operation])).rows[0];
  if(operation){if(operation.kind!=='delete'||operation.preference_id!==id||operation.input_digest!==hash)fail('conflict',409);await this.backups(client);return;}
  const value=payload(row);if(BigInt(value.revision)!==BigInt(c.expected))fail('conflict',409);await this.backups(client);
  await erasePreferences(client,owner,[id],this.deletion.ports);
  await client.query("INSERT INTO public.expression_preference_operation(owner_id,operation_key,preference_id,kind,input_digest,result_revision) VALUES($1,$2,$3,'delete',$4,$5)",[owner,c.operation,id,hash,BigInt(row.revision)+1n]);
 }
 private async save(client:pg.Client,owner:string,selected:string|null,c:any):Promise<any>{
  const hash=digest({text:c.text,contact_id:c.contact??'None',reply_mode:c.mode,origin_kind:c.kind,origin_id:c.origin??'None'});
  const op=(await client.query('SELECT * FROM public.expression_preference_operation WHERE owner_id=$1 AND operation_key=$2',[owner,c.operation])).rows[0];
  if(op){const state=(await client.query('SELECT status,revision FROM public.expression_preference WHERE owner_id=$1 AND id=$2',[owner,op.preference_id])).rows[0];if(!state)fail('not_found',404);if(state.status==='deleted')fail('deleted',410);if(op.kind!=='save'||op.input_digest!==hash||op.result_revision!==state.revision)fail('conflict',409);return current(client,await read(client,owner,op.preference_id,c.contact));}
  await scopeExists(client,owner,c.contact);let sources:string[]=[];
  if(c.kind==='message'){
   if(c.contact===null)fail('conflict',409);
   if(!(await client.query('SELECT 1 FROM public.message WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[owner,c.contact,c.origin])).rowCount)fail('not_found',404);
   const refs=(await client.query('SELECT ref.source_document_id,ref.observation_id,s.status FROM public.message_source_ref ref LEFT JOIN public.source_document s ON s.id=ref.source_document_id WHERE ref.owner_id=$1 AND ref.contact_id=$2 AND ref.message_id=$3',[owner,c.contact,c.origin])).rows;
   if(!refs.length)fail('not_found',404);if(refs.some(r=>r.source_document_id&&r.status!=='active'))fail('conflict',409);
   sources=[...new Set<string>([c.origin,...refs.map(r=>r.source_document_id??r.observation_id)])].sort();
  }
  const row=(await client.query(`INSERT INTO public.expression_preference(owner_id,contact_id,reply_mode,text_content,confirmed_operation_key,origin_kind,origin_id,source_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,[owner,c.contact,c.mode,c.text,c.operation,c.kind,c.origin,sources])).rows[0];
  await client.query("INSERT INTO public.expression_preference_operation(owner_id,operation_key,preference_id,kind,input_digest,result_revision) VALUES($1,$2,$3,'save',$4,1)",[owner,c.operation,row.id,hash]);await bumpPreferenceRevision(client,owner);return payload(row);
 }
 private async update(client:pg.Client,owner:string,selected:string|null,id:string,c:any):Promise<any>{
  const hash=digest({preference_id:id,expected_revision:c.expected,text:c.text,contact_id:c.contact??'None',reply_mode:c.mode});
  const existing=await current(client,await read(client,owner,id,selected));
  if(c.contact!==null&&c.contact!==selected)fail('conflict',409);
  const op=(await client.query('SELECT * FROM public.expression_preference_operation WHERE owner_id=$1 AND operation_key=$2',[owner,c.operation])).rows[0];
  if(op){if(op.kind!=='update'||op.preference_id!==id||op.input_digest!==hash||BigInt(op.result_revision)!==BigInt(existing.revision))fail('conflict',409);return existing;}
  if(BigInt(existing.revision)!==BigInt(c.expected))fail('conflict',409);await scopeExists(client,owner,c.contact);
  if(existing.origin.kind==='message'&&c.contact!==existing.scope.contact_id)fail('conflict',409);
  const row=(await client.query(`UPDATE public.expression_preference SET text_content=$1,contact_id=$2,reply_mode=$3,revision=revision+1,confirmed_operation_key=$4,updated_at=now() WHERE owner_id=$5 AND id=$6 RETURNING ${columns}`,[c.text,c.contact,c.mode,c.operation,owner,id])).rows[0];
  await client.query("INSERT INTO public.expression_preference_operation(owner_id,operation_key,preference_id,kind,input_digest,result_revision) VALUES($1,$2,$3,'update',$4,$5)",[owner,c.operation,id,hash,row.revision]);await bumpPreferenceRevision(client,owner);return payload(row);
 }
}

export interface PreferenceSnapshot { revision:PreferenceRevision; preferences:any[] }
/** 调用方在同一事务中已持owner锁；用于模型前prepare及提交复验，不取得contact锁。 */
export async function selectApplicablePreferences(client:pg.Client,owner:string,contact:string,mode:string):Promise<PreferenceSnapshot>{
 if(!modes.has(mode))fail('invalid',400);await scopeExists(client,owner,contact);
 const revision=await collectionRevision(client,owner);
 const rows=(await client.query(`SELECT ${columns} FROM public.expression_preference WHERE owner_id=$1 AND status='active' AND(contact_id IS NULL OR contact_id=$2) AND(reply_mode IS NULL OR reply_mode=$3) ORDER BY(contact_id IS NOT NULL) DESC,(reply_mode IS NOT NULL) DESC,updated_at DESC,id LIMIT 50`,[owner,contact,mode])).rows;
 const preferences:any[]=[];let used=0;
 for(const row of rows){let item;try{item=await current(client,row);}catch(e){if(e instanceof PreferenceError&&e.status===410)continue;throw e;}
  const size=[...item.text].length;if(size+used>1536)continue;preferences.push(item);used+=size;if(preferences.length===5)break;
 }
 return {revision,preferences};
}
async function collectionRevision(client:pg.Client,owner:string):Promise<PreferenceRevision>{return persistedRevision((await client.query('SELECT revision FROM public.expression_preference_state WHERE owner_id=$1',[owner])).rows[0]?.revision??0);}
export async function validatePreferenceSnapshot(client:pg.Client,owner:string,contact:string,mode:string,snapshot:PreferenceSnapshot):Promise<void>{
 if(!snapshot||!validRevision(snapshot.revision,0)||!Array.isArray(snapshot.preferences)||snapshot.preferences.length>5||!modes.has(mode))fail('conflict',409);
 const items=snapshot.preferences;if(new Set(items.map(i=>i.preference_id)).size!==items.length||items.some(i=>typeof i.text!=='string'||[...i.text].length<1||[...i.text].length>512)||items.reduce((n,i)=>n+[...i.text].length,0)>1536)fail('conflict',409);
 if(BigInt(await collectionRevision(client,owner))!==BigInt(snapshot.revision))fail('conflict',409);
 for(const item of items){const value=await current(client,await read(client,owner,uuid(item.preference_id),contact));
  if(value.scope.reply_mode!==null&&value.scope.reply_mode!==mode)fail('conflict',409);
  if(!validRevision(item.revision)||!isDeepStrictEqual({...value,revision:BigInt(value.revision)},{...item,revision:BigInt(item.revision)}))fail('conflict',409);
 }
}
/** 只捕获同一请求实际使用的偏好，不接受当前目录回填历史。 */
export async function captureReplyPreferences(client:pg.Client,owner:string,contact:string,requestId:string,mode:string,snapshot:PreferenceSnapshot):Promise<void>{
 await validatePreferenceSnapshot(client,owner,contact,mode,snapshot);
 if(!(await client.query('SELECT 1 FROM public.reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[owner,contact,requestId])).rowCount)fail('not_found',404);
 await client.query('DELETE FROM public.reply_expression_preference_use WHERE reply_request_id=$1',[requestId]);
 for(const item of snapshot.preferences)await client.query('INSERT INTO public.reply_expression_preference_use(reply_request_id,preference_id,owner_id,contact_id,preference_revision) VALUES($1,$2,$3,$4,$5)',[requestId,item.preference_id,owner,contact,item.revision]);
 await client.query('UPDATE public.reply_request SET expression_preference_revision=$1 WHERE owner_id=$2 AND contact_id=$3 AND id=$4',[snapshot.revision,owner,contact,requestId]);
}
export async function requireCapturedReplyPreferences(client:pg.Client,owner:string,contact:string,requestId:string,mode:string,snapshot:PreferenceSnapshot):Promise<void>{
 await validatePreferenceSnapshot(client,owner,contact,mode,snapshot);
 const row=(await client.query('SELECT expression_preference_revision FROM public.reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[owner,contact,requestId])).rows[0];
 const used=(await client.query('SELECT preference_id,preference_revision FROM public.reply_expression_preference_use WHERE owner_id=$1 AND contact_id=$2 AND reply_request_id=$3',[owner,contact,requestId])).rows;
 if(!row||row.expression_preference_revision===null||BigInt(row.expression_preference_revision)!==BigInt(snapshot.revision)||used.length!==snapshot.preferences.length||used.some(r=>!snapshot.preferences.some(p=>p.preference_id===r.preference_id&&BigInt(p.revision)===BigInt(r.preference_revision))))fail('conflict',409);
}

/** 来源删除共用同事务擦除，调用方持owner锁并负责备份与提交后文件清理。 */
export async function eraseSourcePreferences(client:pg.Client,owner:string,removedIds:string[],ports?:Partial<ErasurePorts>):Promise<void>{
 const ids=(await client.query("SELECT id FROM public.expression_preference WHERE owner_id=$1 AND status='active' AND source_ids&&$2::uuid[]",[owner,removedIds])).rows.map(r=>r.id);
 await erasePreferences(client,owner,ids,ports);
}
/** 联系人物理删除前擦除本范围偏好，并将无正文墓碑转为 owner 级防重身份。 */
export async function eraseContactPreferences(client:pg.Client,owner:string,contact:string,ports?:Partial<ErasurePorts>):Promise<void>{
 const ids=(await client.query("SELECT id FROM public.expression_preference WHERE owner_id=$1 AND contact_id=$2 AND status='active' FOR UPDATE",[owner,contact])).rows.map(r=>r.id);
 await erasePreferences(client,owner,ids,ports);
 await client.query('UPDATE public.expression_preference SET contact_id=NULL,updated_at=now() WHERE owner_id=$1 AND contact_id=$2',[owner,contact]);
}
async function erasePreferences(client:pg.Client,owner:string,ids:string[],ports?:Partial<ErasurePorts>):Promise<void>{
 if(!ids.length)return;
 await eraseSkillLearning(client,owner,ids,ports);await deleteSourceReplies(client,owner,ids,null,false,ports);
 await client.query("UPDATE public.expression_preference SET status='deleted',text_content=NULL,origin_kind=NULL,origin_id=NULL,source_ids='{}',reply_mode=NULL,revision=revision+1,deleted_at=now(),updated_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[])",[owner,ids]);
 await client.query('UPDATE public.expression_preference_operation SET input_digest=NULL WHERE owner_id=$1 AND preference_id=ANY($2::uuid[])',[owner,ids]);await bumpPreferenceRevision(client,owner);
}
