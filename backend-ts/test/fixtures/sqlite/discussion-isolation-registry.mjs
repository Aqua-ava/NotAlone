import {registry as base} from '../../../src/storage/sqlite/registry.ts';

export const registry={
 ...base,
 actions:[...base.actions,
  {name:'discussionIsolation.inspect',mode:'read',retryBusy:false,execute(tx,i){return {
   discussions:tx.all('SELECT id,state,is_current FROM assistant_discussion WHERE owner_id=? AND contact_id=? ORDER BY id',[i.ownerId,i.contactId]),
   requestCount:tx.get('SELECT COUNT(*) count FROM reply_request WHERE owner_id=? AND contact_id=? AND discussion_id=?',[i.ownerId,i.contactId,i.discussionId]).count,
   requests:tx.all('SELECT id,state FROM reply_request WHERE owner_id=? AND contact_id=? AND discussion_id=? ORDER BY id',[i.ownerId,i.contactId,i.discussionId]),
   attempts:tx.all(`SELECT a.id,a.state,a.error_code FROM reply_attempt a JOIN reply_request r ON r.owner_id=a.owner_id AND r.id=a.request_id
    WHERE r.owner_id=? AND r.contact_id=? AND r.discussion_id=? ORDER BY a.id`,[i.ownerId,i.contactId,i.discussionId]),
   entries:tx.all('SELECT id,role,body,content_state,origin_request_id FROM discussion_entry WHERE owner_id=? AND contact_id=? AND discussion_id=? ORDER BY position',[i.ownerId,i.contactId,i.discussionId]),
   contextCount:tx.get('SELECT COUNT(*) count FROM reply_context WHERE owner_id=? AND contact_id=? AND discussion_id=?',[i.ownerId,i.contactId,i.discussionId]).count,
   candidateInputs:tx.all(`SELECT x.kind,x.text_body,COUNT(s.record_id) source_count
    FROM reply_candidate_input x JOIN reply_context c ON c.owner_id=x.owner_id AND c.id=x.context_id
    LEFT JOIN reply_candidate_input_source s ON s.owner_id=x.owner_id AND s.context_id=x.context_id AND s.item_no=x.item_no
    WHERE c.owner_id=? AND c.contact_id=? AND c.discussion_id=? GROUP BY x.context_id,x.item_no ORDER BY x.item_no`,[i.ownerId,i.contactId,i.discussionId]),
   sourceIds:tx.all('SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? ORDER BY id',[i.ownerId,i.contactId]).map(row=>String(row.id)),
   messages:tx.all('SELECT id,text_body FROM message WHERE owner_id=? AND contact_id=? ORDER BY display_no',[i.ownerId,i.contactId]),
   memories:tx.all(`SELECT m.scope_kind,m.contact_id,v.body FROM memory m JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no
    WHERE m.owner_id=? ORDER BY m.scope_kind,m.contact_id,m.id`,[i.ownerId]),
  };}},
 ]};
