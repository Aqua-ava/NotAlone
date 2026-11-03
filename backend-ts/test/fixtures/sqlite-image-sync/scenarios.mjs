/**
 * 候选回复生成准备延迟优化 P01 的确定性合成夹具。
 *
 * 只使用合成数据；联系人、消息、尝试、请求键、显示号和时间全部固定，
 * 每次构建得到相同的查询输入，用于采集修改前/修改后的结果黄金样例和耗时基线。
 * 通过公开存储动作 `media.imageSyncTargets`／`media.imageRefreshPending` 观测结果，
 * 不直接断言 SQL 字符串。
 */
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {imagePreparationVersion,imageReconcilePrefix} from '../../../src/media/sqlite/image-refresh.ts';

/** 夹具内所有相对时间都围绕该时刻计算；动作的 `now` 输入使用同一时钟。 */
export const SCENARIO_NOW=1_800_000_000_000;
export const MINUTE=60_000;
export const HOUR=60*MINUTE;
export const DAY=24*HOUR;

/** 提取适配器的历史版本：成功尝试不属于当前准备版本，因此会抬升 legacy cutoff。 */
const ADAPTER_VERSION='synthetic-adapter-v1';
/** 旧运行时版本的失败尝试：只用于构成 legacy cutoff。 */
const LEGACY_ADAPTER_VERSION='legacy-runtime-v3';

export function databasePath(root){return join(root,'managed','sqlite','notalone.sqlite');}

export function openDatabase(root,{readOnly=false}={}){
 return readOnly?new DatabaseSync(databasePath(root),{readOnly:true}):new DatabaseSync(databasePath(root),{timeout:5000});
}

function sha256(value){return createHash('sha256').update(value).digest('hex');}

/** 结果行只保留显示号和去掉随机消息 ID 的请求键，保证跨夹具重建可比较。 */
export function normalizeTargets(rows){
 return rows.map(row=>({displayNo:String(row.displayNo),requestKey:String(row.requestKey).split(String(row.messageId)).join('<message>')}));
}

/** 走公开存储动作执行单个查询用例。 */
async function runCase(storage,owner,resolved){
 if(resolved.action==='pending')return storage.execute('media.imageRefreshPending',{ownerId:owner,contactId:resolved.contactId});
 const rows=await storage.execute('media.imageSyncTargets',{ownerId:owner,contactId:resolved.contactId,after:resolved.after,now:resolved.now});
 return {rows,after:resolved.after};
}

/**
 * 依次执行场景用例。`afterFrom` 用例从前一个用例的最后一个显示号继续翻页；
 * 遍历用例按协调器的翻页方式取完全部目标，并保留显示号顺序与结果摘要。
 */
export async function collectCases(storage,scenario){
 const results={};
 for(const item of scenario.cases){
  const resolved={...item};
  if(item.afterFrom)resolved.after=results[item.afterFrom].at(-1)?.displayNo??'0';
  if(item.action==='pending'){
   results[item.name]=await storage.execute('media.imageRefreshPending',{ownerId:scenario.owner,contactId:item.contactId});
   continue;
  }
  if(item.action==='traversal'){
   let after='0';const rows=[];
   for(let page=0;page<64;page++){
    const targets=await storage.execute('media.imageSyncTargets',{ownerId:scenario.owner,contactId:item.contactId,after,now:item.now});
    if(!targets.length)break;
    rows.push(...targets);after=targets.at(-1).displayNo;
    if(rows.length>20_000)throw new Error('synthetic traversal did not terminate');
   }
   const normalized=normalizeTargets(rows);
   results[item.name]={count:normalized.length,displayNos:normalized.map(row=>row.displayNo),sha256:sha256(JSON.stringify(normalized))};
   continue;
  }
  const ran=await runCase(storage,scenario.owner,{...resolved,contactId:item.contactId});
  results[item.name]=normalizeTargets(ran.rows);
 }
 return results;
}

/**
 * 可写合成数据播种器。所有写入都在调用方开启的单个事务中完成；
 * 表结构约束（媒体头触发器、尝试 CHECK、唯一索引）保持开启。
 */
class Seeder{
 #db;#owner;#serial=0;#scopes=new Map();#attemptNos=new Map();#attemptKeys=new Set();
 constructor(db,owner){this.#db=db;this.#owner=owner;}
 get db(){return this.#db;}
 #nextId(kind){this.#serial+=1;return `synthetic-${kind}-${String(this.#serial).padStart(6,'0')}`;}

 /** 建立一个已确认、已授权且没有历史连续围栏的合成联系人。 */
 contact(tag){
  const owner=this.#owner,db=this.#db,contactId=`synthetic-contact-${tag}`;
  db.prepare('INSERT INTO contact(owner_id,id,display_name,selection_generation,data_generation,state) VALUES(?,?,?,?,?,?)')
   .run(owner,contactId,`合成联系人-${tag}`,1,0,'active');
  let account=db.prepare('SELECT id FROM channel_account WHERE owner_id=? LIMIT 1').get(owner);
  if(!account){
   const accountId=`synthetic-account-${tag}`;
   db.prepare('INSERT INTO channel_account(owner_id,id,identity_scheme,external_key,display_name,identity_state,source_generation,scope_mode,scope_revision,scope_confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(owner,accountId,'wechat.account.v1',`synthetic-account-${tag}`,'合成账号','verified','source-1','selected',1,SCENARIO_NOW);
   account={id:accountId};
  }
  const conversationId=`synthetic-conversation-${tag}`;
  db.prepare('INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key,display_name,barrier_generation) VALUES(?,?,?,?,?,?,0)')
   .run(owner,conversationId,account.id,'wechat.conversation.v1',`synthetic-conversation-${tag}`,`合成会话-${tag}`);
  const bindingId=`synthetic-binding-${tag}`;
  db.prepare('INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,identity_generation,state) VALUES(?,?,?,?,0,?)')
   .run(owner,bindingId,contactId,conversationId,'verified');
  const verificationId=`synthetic-verification-${tag}`;
  db.prepare('INSERT INTO binding_verification(owner_id,id,binding_id,identity_generation,method,proof_format,proof,verified_at) VALUES(?,?,?,?,?,?,?,?)')
   .run(owner,verificationId,bindingId,0,'channel_metadata','identity-metadata-v1','{}',SCENARIO_NOW);
  const grantId=`synthetic-grant-${tag}`;
  db.prepare('INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at,revoked_at,reason) VALUES(?,?,?,?,?,?,?,NULL,NULL)')
   .run(owner,grantId,contactId,bindingId,verificationId,1,SCENARIO_NOW);
  const goalId=`synthetic-goal-${tag}`;
  db.prepare(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,cursor,state,coverage_state,completed_partitions,failure_code,created_at)
   VALUES(?,?,?,?,?,0,0,'history','private-history-v1','synthetic-fixed','{}','{}','{}',NULL,'complete','complete','[]',NULL,?)`)
   .run(owner,goalId,contactId,bindingId,grantId,SCENARIO_NOW);
  const scope={tag,contactId,bindingId,grantId,verificationId,goalId,captures:[],displayNos:[]};
  this.#scopes.set(contactId,scope);
  return scope;
 }

 #captureSlot(scope){
  let capture=scope.captures.at(-1);
  if(!capture||capture.items>=1000){
   capture={id:`synthetic-capture-${scope.tag}-${scope.captures.length}`,items:0};
   this.#db.prepare('INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(this.#owner,capture.id,scope.contactId,scope.goalId,1,'synthetic-runtime',SCENARIO_NOW,'synthetic-1',null,`synthetic-cursor-${scope.tag}-${scope.captures.length}`,'accepted','d'.repeat(64));
   scope.captures.push(capture);
  }
  return {captureId:capture.id,itemNo:capture.items++};
 }

 /** 插入一条消息；默认同时建立规范化捕获记录，返回消息与记录 ID。 */
 message(scope,{displayNo,kind='image',availability='available',textBody=null}){
  const owner=this.#owner,db=this.#db,messageId=`synthetic-message-${scope.tag}-${String(displayNo).padStart(6,'0')}`;
  db.prepare(`INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,sent_at,time_precision,order_scheme,order_key,interpretation_revision,availability,display_no)
   VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,1,?,?)`)
   .run(owner,messageId,scope.contactId,scope.bindingId,'synthetic-scenario-v1',JSON.stringify([scope.tag,displayNo]),'contact',kind,textBody,kind,availability,displayNo);
  scope.displayNos.push(String(displayNo));
  const {captureId,itemNo}=this.#captureSlot(scope);
  const recordId=`synthetic-record-${scope.tag}-${String(displayNo).padStart(6,'0')}`;
  db.prepare(`INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code,availability)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,'available')`)
   .run(owner,recordId,scope.contactId,captureId,itemNo,'normalized',messageId,'{}','synthetic-scenario-v1',JSON.stringify([scope.tag,displayNo]),'synthetic-1');
  return {messageId,recordId,displayNo:String(displayNo)};
 }

 /** 只有隔离/排除语义的消息：消息存在但没有规范化捕获记录。 */
 quarantinedCaptureMessage(scope,{displayNo}){
  const {messageId}=this.#insertMessageOnly(scope,{displayNo});
  const {captureId,itemNo}=this.#captureSlot(scope);
  this.#db.prepare(`INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code,availability)
   VALUES(?,?,?,?,?,'quarantined',NULL,NULL,NULL,NULL,'synthetic-1','synthetic_quarantine','available')`)
   .run(this.#owner,this.#nextId('record'),scope.contactId,captureId,itemNo);
  return {messageId};
 }

 #insertMessageOnly(scope,{displayNo,kind='image',availability='available',textBody=null}){
  const owner=this.#owner,messageId=`synthetic-message-${scope.tag}-${String(displayNo).padStart(6,'0')}`;
  this.#db.prepare(`INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,sent_at,time_precision,order_scheme,order_key,interpretation_revision,availability,display_no)
   VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,1,?,?)`)
   .run(owner,messageId,scope.contactId,scope.bindingId,'synthetic-scenario-v1',JSON.stringify([scope.tag,displayNo]),'contact',kind,textBody,kind,availability,displayNo);
  scope.displayNos.push(String(displayNo));
  return {messageId};
 }

 media(scope,{messageId,state='active',generation=0}){
  this.#db.prepare('INSERT INTO message_media(owner_id,message_id,contact_id,media_generation,head_revision,state,created_at) VALUES(?,?,?,?,0,?,?)')
   .run(this.#owner,messageId,scope.contactId,generation,state,SCENARIO_NOW);
 }

 quarantine(scope,messageId){
  this.#db.prepare('INSERT INTO history_message_quarantine(owner_id,contact_id,message_id,reason) VALUES(?,?,?,?)')
   .run(this.#owner,scope.contactId,messageId,'synthetic_quarantine');
 }

 #attemptNo(messageId){
  const next=(this.#attemptNos.get(messageId)??0)+1;this.#attemptNos.set(messageId,next);return next;
 }

 /**
  * 插入一次提取尝试。默认是当前准备版本的失败记录（会参与 preparation 聚合）；
  * `version` 为历史适配器版本时构成 legacy cutoff 数据。
  */
 attempt(scope,{messageId,recordId,goal='extract',version=imagePreparationVersion,requestKey,state='failed',resultOutcome=null,requestedAt,generation=0}){
  const owner=this.#owner;
  if(this.#attemptKeys.has(requestKey))throw new Error(`duplicate synthetic request key: ${requestKey}`);
  this.#attemptKeys.add(requestKey);
  const attemptId=this.#nextId('attempt'),completed=state==='completed';
  const outcome=completed?(resultOutcome??'quality_unknown'):'no_result';
  const lease=state==='pending';
  this.#db.prepare(`INSERT INTO media_extraction_attempt(owner_id,id,contact_id,message_id,request_key,attempt_no,goal,record_id,input_file_id,accepted_media_generation,accepted_head_revision,accepted_data_generation,accepted_read_epoch,accepted_selection_generation,grant_id,binding_verification_id,runtime_token,eligibility_json,runtime_id,state,result_outcome,lease_token,lease_expires_at,requested_at,started_at,finished_at,adapter_version,association_proof_format,association_proof,error_code,cleanup_operation_id)
   VALUES(?,?,?,?,?,?,?,?,NULL,?,0,0,1,1,?,?,'synthetic-runtime','{}','synthetic-runtime',?,?,?,?,?,?,?,?,NULL,NULL,?,NULL)`)
   .run(owner,attemptId,scope.contactId,messageId,requestKey,this.#attemptNo(messageId),goal,recordId,generation,
    scope.grantId,scope.verificationId,state,outcome,
    lease?'synthetic-lease':null,lease?requestedAt+120_000:null,
    requestedAt,lease?null:requestedAt,lease?null:requestedAt,
    version,state==='failed'?'synthetic_failure':null);
  return attemptId;
 }

 /** 已发布 current 图片文件；unknown 质量可按需带来源分类依据。 */
 file(scope,{messageId,producedAttemptId,quality,evidence=null}){
  const owner=this.#owner,fileId=this.#nextId('file');
  this.#db.prepare(`INSERT INTO media_file(owner_id,id,contact_id,message_id,produced_attempt_id,role,image_quality,quality_proof,format,mime_type,byte_size,content_digest,managed_locator,expected_file_identity,managed_address,parent_file_id,content_state,publish_state,container_valid,viewable,playable,created_at,cleanup_operation_id,image_quality_evidence)
   VALUES(?,?,?,?,?,'image_display',?,?,'synthetic','image/png',4,?,?,?,'synthetic-address',NULL,'present','current',1,1,0,?,NULL,?)`)
   .run(owner,fileId,scope.contactId,messageId,producedAttemptId,quality,quality==='original'?'synthetic-original-proof':null,
    'c'.repeat(64),`synthetic-managed://${fileId}`,'synthetic-identity',SCENARIO_NOW,evidence?JSON.stringify(evidence):null);
  return fileId;
 }
}

/** 历史适配器成功尝试的请求键（不是 v5/reconcile 前缀，不参与 retry_count 统计）。 */
const historyRequestKey=(messageId,index)=>`image_sync_v3_${messageId}_${index}`;
/** 当前 v5 自动同步使用过的请求键（历史适配器版本下会被计为 retry）。 */
const retriedRequestKey=(messageId,index)=>`image_sync_v5_${messageId}_${index}`;
const reconcileRequestKey=(messageId,index)=>`${imageReconcilePrefix}${messageId}_${index}_${Math.floor(SCENARIO_NOW/MINUTE)}`;

function withTransaction(root,owner,build){
 const db=openDatabase(root);const seeder=new Seeder(db,owner);
 db.exec('BEGIN');
 try{const value=build(seeder);db.exec('COMMIT');return value;}
 catch(error){db.exec('ROLLBACK');throw error;}
 finally{db.close();}
}

/** 边界场景：分页、排除路径、legacy cutoff、准备退避阶梯和单图重试阶梯。 */
export function buildEdgeScenario(f){
 const built=withTransaction(f.root,f.owner,seeder=>{
  const page=seeder.contact('page');
  for(let displayNo=1001;displayNo<=1070;displayNo++)seeder.media(page,{messageId:seeder.message(page,{displayNo}).messageId});
  // 无媒体头：图片仍待查。
  const noHead=seeder.message(page,{displayNo:1101});
  // 已清除媒体：不参与图片补查。
  const cleared=seeder.message(page,{displayNo:1102});seeder.media(page,{messageId:cleared.messageId,state:'cleared'});
  // 非图片、不可用、隔离、缺少规范化捕获：均不参与。
  seeder.message(page,{displayNo:1103,kind:'text',textBody:'合成文字'});
  const deleting=seeder.message(page,{displayNo:1104,availability:'deleting'});void deleting;
  const quarantined=seeder.message(page,{displayNo:1105});seeder.media(page,{messageId:quarantined.messageId});seeder.quarantine(page,quarantined.messageId);
  seeder.quarantinedCaptureMessage(page,{displayNo:1106});
  // 当前正式原图：不重复读取。
  const original=seeder.message(page,{displayNo:1107});seeder.media(page,{messageId:original.messageId});
  const originalAttempt=seeder.attempt(page,{messageId:original.messageId,recordId:original.recordId,version:ADAPTER_VERSION,requestKey:historyRequestKey(original.messageId,0),state:'completed',resultOutcome:'full',requestedAt:SCENARIO_NOW-10*DAY});
  seeder.file(page,{messageId:original.messageId,producedAttemptId:originalAttempt,quality:'original'});
  // 缩略图：按刷新窗口复查。
  const thumbnail=seeder.message(page,{displayNo:1108});seeder.media(page,{messageId:thumbnail.messageId});
  const thumbnailAttempt=seeder.attempt(page,{messageId:thumbnail.messageId,recordId:thumbnail.recordId,version:ADAPTER_VERSION,requestKey:historyRequestKey(thumbnail.messageId,0),state:'completed',resultOutcome:'full',requestedAt:SCENARIO_NOW-10*DAY});
  seeder.file(page,{messageId:thumbnail.messageId,producedAttemptId:thumbnailAttempt,quality:'thumbnail'});
  // 未知质量但缺来源分类依据：仍需补查。
  const unknown=seeder.message(page,{displayNo:1109});seeder.media(page,{messageId:unknown.messageId});
  const unknownAttempt=seeder.attempt(page,{messageId:unknown.messageId,recordId:unknown.recordId,version:ADAPTER_VERSION,requestKey:historyRequestKey(unknown.messageId,0),state:'completed',resultOutcome:'quality_unknown',requestedAt:SCENARIO_NOW-10*DAY});
  seeder.file(page,{messageId:unknown.messageId,producedAttemptId:unknownAttempt,quality:'unknown'});
  // 未知质量且已有 main 分类依据：不重复读取。
  const classified=seeder.message(page,{displayNo:1110});seeder.media(page,{messageId:classified.messageId});
  const classifiedAttempt=seeder.attempt(page,{messageId:classified.messageId,recordId:classified.recordId,version:ADAPTER_VERSION,requestKey:historyRequestKey(classified.messageId,0),state:'completed',resultOutcome:'quality_unknown',requestedAt:SCENARIO_NOW-10*DAY});
  seeder.file(page,{messageId:classified.messageId,producedAttemptId:classifiedAttempt,quality:'unknown',evidence:{sourceVariant:'main'}});
  // 新一代图片头：只为同一 generation 的尝试退避。
  const generation=seeder.message(page,{displayNo:1111});seeder.media(page,{messageId:generation.messageId,generation:1});
  seeder.attempt(page,{messageId:generation.messageId,recordId:generation.recordId,version:ADAPTER_VERSION,requestKey:historyRequestKey(generation.messageId,0),state:'completed',resultOutcome:'full',requestedAt:SCENARIO_NOW-10*DAY,generation:1});
  // 运行中的尝试：同消息不再派发。
  const running=seeder.message(page,{displayNo:1112});seeder.media(page,{messageId:running.messageId});
  seeder.attempt(page,{messageId:running.messageId,recordId:running.recordId,version:imagePreparationVersion,requestKey:retriedRequestKey(running.messageId,0),state:'pending',requestedAt:SCENARIO_NOW-10*DAY});
  // 历史适配器且命中 v5/reconcile 键：按一分钟退避，当前未到期。
  const retryDue=seeder.message(page,{displayNo:1113});seeder.media(page,{messageId:retryDue.messageId});
  seeder.attempt(page,{messageId:retryDue.messageId,recordId:retryDue.recordId,version:ADAPTER_VERSION,requestKey:reconcileRequestKey(retryDue.messageId,0),state:'completed',resultOutcome:'quality_unknown',requestedAt:SCENARIO_NOW-30_000});
  // 旧前缀尝试不计重试，且仍会抬升 legacy cutoff。
  const legacyOnly=seeder.message(page,{displayNo:1114});seeder.media(page,{messageId:legacyOnly.messageId});
  seeder.attempt(page,{messageId:legacyOnly.messageId,recordId:legacyOnly.recordId,version:LEGACY_ADAPTER_VERSION,requestKey:historyRequestKey(legacyOnly.messageId,0),state:'failed',requestedAt:SCENARIO_NOW-10*DAY});
  // 只有原图升级目标的旧尝试不进入 attempts CTE，但进入 legacy cutoff。
  const upgradeOnly=seeder.message(page,{displayNo:1115});seeder.media(page,{messageId:upgradeOnly.messageId});
  seeder.attempt(page,{messageId:upgradeOnly.messageId,recordId:upgradeOnly.recordId,goal:'original_upgrade',version:LEGACY_ADAPTER_VERSION,requestKey:`image_original_v1_${upgradeOnly.messageId}_0`,state:'failed',requestedAt:SCENARIO_NOW-10*DAY});
  // 无媒体头的图片没有尝试记录（尝试必须挂在媒体头上），仍直接到期。
  seeder.message(page,{displayNo:1116});

  // 已有 legacy cutoff：cutoff 之后的当前版本尝试才计入 preparation。
  const cutoff=seeder.contact('cutoff');
  const cutoffMessages=[];
  for(let displayNo=3001;displayNo<=3010;displayNo++){
   const message=seeder.message(cutoff,{displayNo});seeder.media(cutoff,{messageId:message.messageId});cutoffMessages.push(message);
  }
  for(const message of cutoffMessages.slice(0,5)){
   seeder.attempt(cutoff,{messageId:message.messageId,recordId:message.recordId,version:LEGACY_ADAPTER_VERSION,requestKey:historyRequestKey(message.messageId,0),state:'failed',requestedAt:SCENARIO_NOW-2*MINUTE});
  }
  for(const message of cutoffMessages.slice(5)){
   seeder.attempt(cutoff,{messageId:message.messageId,recordId:message.recordId,version:imagePreparationVersion,requestKey:retriedRequestKey(message.messageId,0),state:'failed',requestedAt:SCENARIO_NOW-30_000});
  }
  // cutoff 再抬升到这些当前版本尝试之后：它们不再计入 preparation，因此立刻到期。
  seeder.attempt(cutoff,{messageId:cutoffMessages[0].messageId,recordId:cutoffMessages[0].recordId,version:LEGACY_ADAPTER_VERSION,requestKey:historyRequestKey(cutoffMessages[0].messageId,1),state:'failed',requestedAt:SCENARIO_NOW-2*MINUTE});

  // preparation 退避阶梯：空 legacy cutoff，当前版本尝试次数决定联系人级退避。
  const ladders=[];
  for(const [index,count] of [1,2,3,4,5].entries()){
   const scope=seeder.contact(`ladder-${count}`);
   for(let slot=0;slot<count;slot++){
    const message=seeder.message(scope,{displayNo:4000+index*20+slot});seeder.media(scope,{messageId:message.messageId});
    seeder.attempt(scope,{messageId:message.messageId,recordId:message.recordId,version:imagePreparationVersion,requestKey:`image_sync_v5_${message.messageId}_${SCENARIO_NOW-30_000}`,state:'failed',requestedAt:SCENARIO_NOW-30_000});
   }
   const plain=seeder.message(scope,{displayNo:4000+index*20+19});seeder.media(scope,{messageId:plain.messageId});
   const delay=[MINUTE,5*MINUTE,30*MINUTE,6*HOUR,DAY][index];
   ladders.push({scope,count,delay,dueAt:SCENARIO_NOW-30_000+delay});
  }

  // 单图重试阶梯：历史适配器命中 v5 键的尝试次数决定每张图片的退避。
  const retry=seeder.contact('retry');
  const retryDelays=[MINUTE,5*MINUTE,30*MINUTE,6*HOUR,DAY,DAY];
  for(let index=0;index<retryDelays.length;index++){
   const message=seeder.message(retry,{displayNo:5001+index});seeder.media(retry,{messageId:message.messageId});
   for(let attempt=0;attempt<=index;attempt++){
    seeder.attempt(retry,{messageId:message.messageId,recordId:message.recordId,version:ADAPTER_VERSION,requestKey:retriedRequestKey(message.messageId,attempt),state:'failed',requestedAt:SCENARIO_NOW-30_000});
   }
  }
  return {page,cutoff,ladders,retry,retryDelays};
 });

 const {page,cutoff,ladders,retry,retryDelays}=built;
 const cases=[];
 const targets=(name,scope,{after='0',now=SCENARIO_NOW,afterFrom}={})=>cases.push({name,contactId:scope.contactId,action:'targets',after,now,...(afterFrom?{afterFrom}:{})});
 const pending=(name,scope)=>cases.push({name,contactId:scope.contactId,action:'pending'});
 targets('edge/page-first',page,{});
 targets('edge/page-second',page,{afterFrom:'edge/page-first'});
 targets('edge/page-second-refresh-window',page,{afterFrom:'edge/page-first',now:SCENARIO_NOW+MINUTE+1000});
 pending('edge/page-pending',page);
 targets('edge/cutoff',cutoff,{});
 pending('edge/cutoff-pending',cutoff);
 for(const ladder of ladders){
  targets(`edge/ladder-${ladder.count}-before`,ladder.scope,{});
  targets(`edge/ladder-${ladder.count}-due`,ladder.scope,{now:ladder.dueAt});
  pending(`edge/ladder-${ladder.count}-pending`,ladder.scope);
 }
 for(const offset of [0,MINUTE+1000,5*MINUTE+1000,30*MINUTE+1000,6*HOUR+1000,DAY+1000]){
  targets(`edge/retry-${offset}`,retry,{now:SCENARIO_NOW+offset});
 }
 return {
  owner:f.owner,
  contacts:{page,cutoff,retry,ladders:ladders.map(ladder=>({contactId:ladder.scope.contactId,count:ladder.count,delay:ladder.delay,dueAt:ladder.dueAt,displayNos:ladder.scope.displayNos}))},
  cases,
 };
}

/**
 * 大联系人场景：约 1,200 条图片消息与约 5,800 次提取尝试。
 * 先写入历史适配器尝试，再写入当前准备版本尝试（位于 legacy cutoff 之后，参与 preparation 聚合），
 * 使修改前实现的相关子查询按“当前版本行 × 尝试数”扫描。
 */
export function buildLargeScenario(f){
 const built=withTransaction(f.root,f.owner,seeder=>{
  const large=seeder.contact('large');
  const messages=[];
  const refreshIndexes=new Set();
  for(let index=1;index<=1200;index++){
   const displayNo=3000+index;
   const variant=index%17===0?'cleared':index%19===0?'original':index%23===0?'thumbnail'
    :index%29===0?'quarantine':index%31===0?'classified':index%37===0?'no-capture'
    :index%41===0?'no-head':index%43===0?'pending':index%61===0?'generation':index%53===0?'refresh':'plain';
   if(variant==='no-capture'){
    const message=seeder.quarantinedCaptureMessage(large,{displayNo});messages.push({index,displayNo,...message,variant});continue;
   }
   const message=seeder.message(large,{displayNo});messages.push({index,displayNo,...message,variant});
   if(variant==='cleared')seeder.media(large,{messageId:message.messageId,state:'cleared'});
   else if(variant==='generation')seeder.media(large,{messageId:message.messageId,generation:1});
   else if(variant!=='no-head')seeder.media(large,{messageId:message.messageId});
   if(variant==='quarantine')seeder.quarantine(large,message.messageId);
  }
  // 历史适配器尝试：每条消息 2–8 次，抬升 legacy cutoff。
  for(const message of messages){
   if(message.variant==='no-capture'||message.variant==='no-head')continue;
   const generation=message.variant==='generation'?1:0,count=(message.index%7)+2;
   for(let attempt=0;attempt<count;attempt++){
    const goal=(message.index+attempt)%5===0?'original_upgrade':'extract';
    const attemptId=seeder.attempt(large,{messageId:message.messageId,recordId:message.recordId,goal,version:LEGACY_ADAPTER_VERSION,
     requestKey:historyRequestKey(message.messageId,attempt),state:goal==='extract'?'completed':'failed',resultOutcome:'full',requestedAt:SCENARIO_NOW-10*DAY-attempt*MINUTE,generation});
    if(goal==='extract'&&message.producer===undefined)message.producer=attemptId;
   }
  }
  // 历史刷新成功：命中 v5/reconcile 键，按一分钟退避，当前未到期。
  for(const message of messages){
   if(message.variant!=='refresh')continue;
   seeder.attempt(large,{messageId:message.messageId,recordId:message.recordId,version:ADAPTER_VERSION,
    requestKey:reconcileRequestKey(message.messageId,0),state:'completed',resultOutcome:'quality_unknown',requestedAt:SCENARIO_NOW-30_000});
  }
  // 当前准备版本尝试：位于所有 legacy 行之后，参与 preparation 聚合。
  for(const message of messages){
   if(message.variant==='no-capture'||message.variant==='no-head')continue;
   const generation=message.variant==='generation'?1:0;
   seeder.attempt(large,{messageId:message.messageId,recordId:message.recordId,version:imagePreparationVersion,
    requestKey:`image_sync_v5_${message.messageId}_${SCENARIO_NOW-10*DAY}`,state:'failed',requestedAt:SCENARIO_NOW-10*DAY,generation});
  }
  // 运行中的尝试排在最后：不进入 legacy cutoff，但阻止该消息派发。
  for(const message of messages){
   if(message.variant!=='pending')continue;
   seeder.attempt(large,{messageId:message.messageId,recordId:message.recordId,version:imagePreparationVersion,
    requestKey:retriedRequestKey(message.messageId,0),state:'pending',requestedAt:SCENARIO_NOW-10*DAY});
  }
  // 文件只在尝试完成后发布：原图排除、缩略图刷新、unknown 分类依据。
  for(const message of messages){
   if(!message.producer)continue;
   if(message.variant==='original')seeder.file(large,{messageId:message.messageId,producedAttemptId:message.producer,quality:'original'});
   if(message.variant==='thumbnail')seeder.file(large,{messageId:message.messageId,producedAttemptId:message.producer,quality:'thumbnail'});
   if(message.variant==='classified')seeder.file(large,{messageId:message.messageId,producedAttemptId:message.producer,quality:'unknown',evidence:{sourceVariant:'main'}});
  }
  return {large};
 });
 const {large}=built;
 const cases=[
  {name:'large/first-page',contactId:large.contactId,action:'targets',after:'0',now:SCENARIO_NOW},
  {name:'large/second-page',contactId:large.contactId,action:'targets',afterFrom:'large/first-page',now:SCENARIO_NOW},
  {name:'large/refresh-window',contactId:large.contactId,action:'targets',after:'0',now:SCENARIO_NOW+MINUTE+1000},
  {name:'large/refresh-after',contactId:large.contactId,action:'targets',after:'3052',now:SCENARIO_NOW+MINUTE+1000},
  {name:'large/traversal',contactId:large.contactId,action:'traversal',now:SCENARIO_NOW},
  {name:'large/pending',contactId:large.contactId,action:'pending'},
 ];
 return {owner:f.owner,contacts:{large:{contactId:large.contactId,displayNos:large.displayNos}},cases};
}
