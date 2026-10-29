import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {combinedKnowledgeReader} from '../../../src/memory/sqlite/documents/knowledge.ts';
// 产品回复及删除动作直接复用正式注册表；仅补隔离库只读断言和故障注入。
export const registry={...base,actions:[...base.actions,
 {name:'fixture.documentKnowledge',mode:'read',retryBusy:false,execute:(tx,input)=>combinedKnowledgeReader.read(tx,input)},
 {name:'fixture.documentCurrent',mode:'read',retryBusy:false,execute(tx,input){combinedKnowledgeReader.requireCurrent(tx,input.scope,input.item);return true;}},
 {name:'fixture.replyDocumentSources',mode:'read',retryBusy:false,execute(tx,input){return tx.all(`SELECT i.identity_json,s.source_contact_id,s.record_id,s.message_id,s.accepted_revision
  FROM reply_candidate_input i JOIN reply_candidate_input_source s ON s.owner_id=i.owner_id AND s.context_id=i.context_id AND s.item_no=i.item_no
  JOIN reply_context c ON c.owner_id=i.owner_id AND c.id=i.context_id
  WHERE i.owner_id=? AND c.discussion_id=? AND i.kind='document' ORDER BY i.item_no,s.source_contact_id,s.record_id`,[input.ownerId,input.discussionId]);}},
 {name:'fixture.documentProvenance',mode:'read',retryBusy:false,execute(tx,input){return tx.all(`SELECT DISTINCT pm.document_id,pm.version_no,v.version_identity,r.source_contact_id
  FROM publication_member pm JOIN memory_document_version v ON v.owner_id=pm.owner_id AND v.document_id=pm.document_id AND v.version_no=pm.version_no
  JOIN document_basis b ON b.owner_id=pm.owner_id AND b.document_id=pm.document_id AND b.version_no=pm.version_no
  JOIN execution_input x ON x.owner_id=b.owner_id AND x.event_id=b.event_id AND x.input_no=b.input_no
  JOIN step_input i ON i.owner_id=x.owner_id AND i.step_id=x.planned_step_id AND i.input_no=x.planned_input_no AND i.kind='memory'
  JOIN memory_required_message r ON r.owner_id=i.owner_id AND r.memory_id=i.memory_id AND r.version_no=i.memory_version_no
  WHERE pm.owner_id=? AND pm.publication_id=? ORDER BY pm.document_id,r.source_contact_id`,[input.ownerId,input.publicationId]);}},
 {name:'fixture.documentStepInputs',mode:'read',retryBusy:false,execute(tx,input){return tx.all('SELECT kind,source_contact_id,document_id,document_version_no,publication_id FROM step_input WHERE owner_id=? AND step_id=? ORDER BY input_no',[input.ownerId,input.stepId]);}},
 // 仅对隔离合成库注入缺失成员或输入的损坏，不提供给产品入口。
 {name:'fixture.removeDocumentMember',mode:'write',retryBusy:false,execute(tx,input){
  const row=tx.get('SELECT document_id FROM publication_member WHERE owner_id=? AND publication_id=? ORDER BY document_id LIMIT 1',[input.ownerId,input.publicationId]);
  if(!row)throw new Error('synthetic_member_missing');
  tx.run('DELETE FROM publication_member WHERE owner_id=? AND publication_id=? AND document_id=?',[input.ownerId,input.publicationId,row.document_id]);
 }},
 {name:'fixture.removeDocumentInput',mode:'write',retryBusy:false,execute(tx,input){
  const row=tx.get(`SELECT incoming.event_id,incoming.input_no FROM document_basis b
   JOIN execution_input basis ON basis.owner_id=b.owner_id AND basis.event_id=b.event_id AND basis.input_no=b.input_no
   JOIN execution_event output ON output.owner_id=b.owner_id AND output.id=b.event_id
   JOIN execution_event input ON input.owner_id=output.owner_id AND input.step_attempt_id=output.step_attempt_id AND input.kind='document_input' AND input.originated_call_id=output.originated_call_id
   JOIN execution_input incoming ON incoming.owner_id=input.owner_id AND incoming.event_id=input.id AND incoming.planned_step_id=basis.planned_step_id AND incoming.planned_input_no=basis.planned_input_no
   WHERE b.owner_id=? AND b.document_id=? LIMIT 1`,[input.ownerId,input.documentId]);
  if(!row)throw new Error('synthetic_input_missing');
  tx.run('DELETE FROM execution_input WHERE owner_id=? AND event_id=? AND input_no=?',[input.ownerId,row.event_id,row.input_no]);
 }},
]};
