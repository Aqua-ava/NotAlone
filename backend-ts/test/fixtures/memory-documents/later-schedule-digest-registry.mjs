import {randomUUID,createHash} from 'node:crypto';
import {registry as laterRegistry} from './later-schedule-registry.mjs';
import {laterScheduleMigration,memoryDocumentsLaterScheduleActions} from '../../../src/memory/sqlite/documents/later-schedule.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {finishLaterStagePublication} from '../../../src/memory/sqlite/documents/later-schedule.ts';

const installed=laterRegistry.migrations.some(migration=>migration.sql.includes('CREATE TABLE memory_document_later_schedule'));
const version=Math.max(...laterRegistry.migrations.map(migration=>migration.version))+1;

// 原实现（N+1 查询 + 逐次比较器序列化）逐字保留作摘要参照；用于证明新实现产出逐字节相同。
const legacyBodyDigest=(tx,ownerId,publicationId)=>{
 const docs=tx.all(`SELECT d.id FROM publication_member m JOIN memory_document d ON d.owner_id=m.owner_id AND d.id=m.document_id
  WHERE m.owner_id=? AND m.publication_id=? AND d.kind='scene' ORDER BY d.id`,[ownerId,publicationId]);
 const bodies=docs.map(doc=>tx.all('SELECT s.body FROM document_statement s JOIN publication_member m ON m.owner_id=s.owner_id AND m.document_id=s.document_id AND m.version_no=s.version_no WHERE m.owner_id=? AND m.publication_id=? AND s.document_id=? ORDER BY s.block_no,s.statement_no',[ownerId,publicationId,doc.id]).map(row=>String(row.body)));
 bodies.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return bodies;
};

export const registry={
 ...laterRegistry,
 migrations:installed?laterRegistry.migrations:[...laterRegistry.migrations,laterScheduleMigration(version)],
 actions:[
  ...(installed?laterRegistry.actions:[...laterRegistry.actions,...memoryDocumentsLaterScheduleActions]),
  // 直接种出一份可用 publication 与运行中的 scene 阶段行，供 finishLaterStagePublication 走真实 bodyDigest。
  {name:'fixture.digestSeed',mode:'write',retryBusy:false,execute(tx,input){
   try{
   const ownerId=String(input.ownerId),scopeKind=input.scopeKind==='self'?'self':'contact';
   const contactId=scopeKind==='contact'?String(input.contactId):null,scopeKey=scopeKind==='self'?'self':contactId;
   const documentCount=Number(input.documentCount),statementsPerDoc=Number(input.statementsPerDoc);
   const emptyDocs=Number(input.emptyDocs??0),outOfOrder=input.outOfOrder===true,unicode=input.unicode===true;
   const runId=randomUUID(),taskId=randomUUID(),publicationId=randomUUID(),attemptId=randomUUID(),stepId=randomUUID();
   tx.run('INSERT INTO owner(owner_id,created_at,memory_revision,document_revision,current_publication_id) VALUES(?,?,1,1,?)',[ownerId,0,publicationId]);
   if(scopeKind==='contact')tx.run("INSERT INTO contact(owner_id,id,memory_revision,document_revision,current_publication_id,state) VALUES(?,?,1,1,?,'active')",[ownerId,contactId,publicationId]);
   tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,started_at,accepted_owner_feedback_revision,policy_config) VALUES(?,?,?,'running',0,0,'{}')",[ownerId,runId,`digest-seed:${randomUUID()}`]);
   tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,contact_id,state,document_basis_state,accepted_memory_revision,accepted_document_revision) VALUES(?,?,?,?,?,'succeeded','frozen',1,1)",[ownerId,taskId,runId,scopeKind,contactId]);
   // step 与 attempt 互为外键：先建 step，再建 attempt，最后回填 successful_attempt_id。
   tx.run("INSERT INTO processing_step(owner_id,id,task_id,step_no,kind,state,input_state,accepted_memory_revision) VALUES(?,?,?,1,'document_scene','succeeded','frozen',1)",[ownerId,stepId,taskId]);
   tx.run("INSERT INTO step_attempt(owner_id,id,step_id,attempt_no,resume_no,lease_token,lease_expires_at,accepted_control_revision,runtime_token,state,started_at) VALUES(?,?,?,1,0,'test',0,0,'test','succeeded',0)",[ownerId,attemptId,stepId]);
   tx.run('UPDATE processing_step SET successful_attempt_id=? WHERE owner_id=? AND id=?',[attemptId,ownerId,stepId]);
   const docIds=[];
   const seedDocument=(index,statements)=>{
    const documentId=randomUUID();docIds.push(documentId);
    tx.run("INSERT INTO memory_document(owner_id,id,scope_kind,contact_id,kind,state) VALUES(?,?,?,?, 'scene','active')",[ownerId,documentId,scopeKind,contactId]);
    tx.run("INSERT INTO memory_document_version(owner_id,document_id,version_no,version_identity,title,produced_attempt_id,input_contract_version,content_state) VALUES(?,?,1,?,?,?,'digest-seed-v1','present')",[ownerId,documentId,`digest-identity-${index}`,`场景${index}`,attemptId]);
    const blocks=Math.max(0,Math.ceil(statements/10));
    for(let b=blocks;b>=1;b--)tx.run("INSERT INTO document_block(owner_id,document_id,version_no,block_no,kind) VALUES(?,?,1,?,'scene')",[ownerId,documentId,b]);
    for(let s=statements;s>=1;s--){
     // 乱序插入时混入需 JSON 转义与空串正文，覆盖序列化边界。
     const body=unicode&&s===statements&&index===0
      ?'园艺 🌱 "引号" 与\\反斜杠\n换行\t制表'
      :s===1&&index===0?'':`合成场景正文：${scopeKey} 文档${index} 第${s}条稳定事实，长度约一百二十字节的测量样本。`;
     tx.run("INSERT INTO document_statement(owner_id,document_id,version_no,block_no,statement_no,kind,body) VALUES(?,?,1,?,?,'fact',?)",[ownerId,documentId,Math.ceil(s/10),s,body]);
    }
   };
   // 逆序插入文档与语句，逼迫查询靠 ORDER BY 而非插入顺序取得正确序列。
   for(let d=documentCount-1;d>=0;d--)seedDocument(d,outOfOrder?Math.max(0,statementsPerDoc-1):statementsPerDoc);
   for(let e=0;e<emptyDocs;e++)seedDocument(1000+e,0);
   tx.run("INSERT INTO document_publication(owner_id,id,scope_kind,contact_id,publication_no,run_id,input_contract_version,basis_task_id,published_at,member_count,members_digest,availability) VALUES(?,?,?,?,1,?,'digest-seed-v1',?,?,?,?,'available')",
    [ownerId,publicationId,scopeKind,contactId,runId,taskId,0,docIds.length,'0'.repeat(64)]);
   for(const docId of [...docIds].reverse())tx.run('INSERT INTO publication_member(owner_id,publication_id,document_id,version_no) VALUES(?,?,?,1)',[ownerId,publicationId,docId]);
   tx.run(`INSERT INTO memory_document_later_schedule(owner_id,scope_kind,scope_key,contact_id,generation,stage,state,first_changed_at,last_changed_at,due_at,requested_memory_revision,task_id,frozen_memory_revision,frozen_document_revision,frozen_publication_id)
    VALUES(?,?,?,?,1,'document_scene','running',?,?,?,?,?,1,1,?)`,[ownerId,scopeKind,scopeKey,contactId,0,0,0,1,taskId,publicationId]);
   return {ownerId,contactId,taskId,publicationId,documentCount:docIds.length};
   }catch(error){throw new StorageFailure(`digest_seed_${error instanceof Error?error.message:String(error)}`);}
  }},
  // 同一事务内先用原实现算参照摘要，再走真实 finishLaterStagePublication，两份摘要必须逐字节相同。
  {name:'fixture.digestVerify',mode:'write',retryBusy:false,execute(tx,input){
   try{
   const ownerId=String(input.ownerId),taskId=String(input.taskId),publicationId=String(input.publicationId);
   const legacyDigest=createHash('sha256').update(JSON.stringify(legacyBodyDigest(tx,ownerId,publicationId))).digest('hex');
   const result=finishLaterStagePublication(tx,ownerId,taskId,0);
   const cursor=tx.get('SELECT scene_body_digest FROM memory_document_later_cursor WHERE owner_id=?',[ownerId]);
   const scene=tx.get("SELECT state,scene_body_digest FROM memory_document_later_schedule WHERE owner_id=? AND task_id=? AND stage='document_scene'",[ownerId,taskId]);
   return {legacyDigest,result,
    cursorDigest:cursor===undefined?null:String(cursor.scene_body_digest),
    sceneState:scene===undefined?null:String(scene.state),
    sceneRowDigest:scene===undefined||scene.scene_body_digest===null?null:String(scene.scene_body_digest)};
   }catch(error){throw new StorageFailure(`digest_verify_${error instanceof Error?error.message:String(error)}`);}
  }},
 ],
};
