import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {replyCandidateQueryAllowed} from '../src/reply/sqlite/candidates/http.ts';

const contactId=randomUUID(),discussionId=randomUUID(),requestId=randomUUID();
const url=path=>new URL(path,'http://localhost');

test('宿主只放行候选状态与Skill详情的固定只读查询',()=>{
 const status=`/api/contacts/${contactId}/assistant-sessions/${discussionId}/reply-candidates/status`;
 const skills=`/api/contacts/${contactId}/assistant-sessions/${discussionId}/reply-candidates/${requestId}/skills`;
 assert.equal(replyCandidateQueryAllowed('GET',url(`${status}?request_key=${randomUUID()}`)),true);
 assert.equal(replyCandidateQueryAllowed('GET',url(`${skills}?offset=0`)),true);
 assert.equal(replyCandidateQueryAllowed('GET',url(skills)),true);

 assert.equal(replyCandidateQueryAllowed('POST',url(`${status}?request_key=${randomUUID()}`)),false);
 assert.equal(replyCandidateQueryAllowed('GET',url(`${status}?request_key=${randomUUID()}&owner_id=${requestId}`)),false);
 assert.equal(replyCandidateQueryAllowed('GET',url(`${status}?request_key=not-a-uuid`)),false);
 assert.equal(replyCandidateQueryAllowed('GET',url(`${status}?request_key=${randomUUID()}&request_key=${randomUUID()}`)),false);
 assert.equal(replyCandidateQueryAllowed('GET',url(`${skills}?offset=-1`)),false);
 assert.equal(replyCandidateQueryAllowed('GET',url(`${skills}?offset=0&cursor=secret`)),false);
 assert.equal(replyCandidateQueryAllowed('GET',url(`/api/contacts/${contactId}/assistant-sessions/${discussionId}/reply-candidates?owner_id=${requestId}`)),false);
});
