import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {
  AssistantDiscussionService,
  AssistantDiscussionError,
} from '../src/reply/discussion/assistant-discussion-service.ts';
import {PostgresReplyStore} from '../src/reply/generation/reply-store.ts';
import {deleteSourceReplies} from '../src/preferences/preference-erasure.ts';
import pg from 'pg';
import {readPublicReplyEvidence} from '../src/host/pure-ts-reply-evidence.ts';

async function fixture(t) {
  const storage = await createStorageFixture();
  t.after(() => storage.close());
  const owner = randomUUID();
  const contact = randomUUID();
  const binding = randomUUID();
  await storage.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')", [owner]);
  await storage.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')", [contact, owner]);
  await storage.client.query(
    "INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic','fixture')",
    [binding, owner, contact],
  );
  const transaction = async (work) => {
    await storage.client.query('BEGIN');
    try {
      const result = await work(storage.client);
      await storage.client.query('COMMIT');
      return result;
    } catch (error) {
      await storage.client.query('ROLLBACK');
      throw error;
    }
  };
  const environment = {};
  const service = new AssistantDiscussionService({
    transaction,
    skillsRoot: `${storage.directory}/skills`,
    environment,
  });
  return {storage, owner, contact, binding, transaction, environment, service};
}

async function completedGeneration(f, session, text = '合成原候选', binding = f.binding) {
  const turn = randomUUID();
  const input = randomUUID();
  const requestKey = randomUUID();
  const request = randomUUID();
  const candidate = randomUUID();
  const message = randomUUID();
  const evidence = randomUUID();
  const group = [{message_id: message, text}];
  const context = {
    evidence: [{evidence_id:evidence,kind:'user_draft',text,source_ids:[],selection_reason:'合成输入',status:'active'}],
    snapshot:{},
  };
  await f.storage.client.query(
    `INSERT INTO reply_request(
       id,owner_id,contact_id,conversation_binding_id,idempotency_key,
       normalized_input,state,attempt,lease_expires_at,context_snapshot,skill_library_revision
     ) VALUES($1,$2,$3,$4,$5,'synthetic','completed',1,now(),$6,0)`,
    [request, f.owner, f.contact, binding, requestKey, JSON.stringify(context)],
  );
  await f.storage.client.query(
    `INSERT INTO assistant_session_turn(
       id,session_id,owner_id,contact_id,input_version_id,idempotency_key,
       conversation_binding_id,input_digest,input_payload,state,reply_request_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',$10)`,
    [
      turn, session, f.owner, f.contact, input, requestKey, binding,
      'a'.repeat(64), JSON.stringify({content: {type: 'rewrite_draft'}}), request,
    ],
  );
  await f.storage.client.query(
    `INSERT INTO assistant_session_input(
       id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id
     ) VALUES($1,$2,$3,$4,$5,'generation',$6)`,
    [input, session, f.owner, f.contact, binding, turn],
  );
  await f.storage.client.query(
    `INSERT INTO reply_context_evidence(
       reply_request_id,evidence_id,owner_id,contact_id,conversation_binding_id,
       ordinal,kind,evidence_text,source_ids
     ) VALUES($1,$2,$3,$4,$5,0,'user_draft',$6,'[]')`,
    [request, evidence, f.owner, f.contact, binding, text],
  );
  await f.storage.client.query(
    `INSERT INTO reply_candidate(
       id,reply_request_id,owner_id,contact_id,conversation_binding_id,
       ordinal,candidate_text,basis,risk_notes,message_group
     ) VALUES($1,$2,$3,$4,$5,0,$6,'合成依据','[]',$7)`,
    [candidate, request, f.owner, f.contact, binding, text, JSON.stringify(group)],
  );
  await f.storage.client.query(
    'INSERT INTO reply_candidate_citation(reply_request_id,candidate_id,evidence_id,ordinal) VALUES($1,$2,$3,0)',
    [request, candidate, evidence],
  );
  await f.storage.client.query(
    'UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',
    [session, input],
  );
  return {turn, input, requestKey, request, candidate, message, evidence, group};
}

test('讨论和候选依据读取可共享来源锁，写操作仍与读取互斥', async (t) => {
  const f = await fixture(t), scope = {owner_id:f.owner,contact_id:f.contact};
  const session = await f.service.defaultSession(scope);
  const generated = await completedGeneration(f,session);
  const database = (await f.storage.client.query('SELECT current_database() AS name')).rows[0].name;
  const holder = new pg.Client({host:'/tmp',database});
  await holder.connect();
  const transaction = work => f.transaction(async client => {
    await client.query("SET LOCAL lock_timeout = '100ms'");
    return work(client);
  });
  const service = new AssistantDiscussionService({transaction,skillsRoot:`${f.storage.directory}/skills`});
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`owner:${f.owner}`]);
    await holder.query('SELECT id FROM assistant_session WHERE id=$1 FOR SHARE',[session]);
    assert.equal((await service.readCandidate(scope,session,generated.candidate)).candidate_id,generated.candidate);
    assert.equal(await service.selectedCandidate(scope,session),null);
    assert.equal((await service.readSession(scope,session)).turns[0].state,'completed');
    assert.equal((await readPublicReplyEvidence({runtimeOwnerId:f.owner,businessTransaction:transaction},
      `${f.storage.directory}/skills`,f.contact,generated.request)).status,200);
    await assert.rejects(service.createSession(scope),error => error instanceof AssistantDiscussionError && error.code==='unavailable',
      '写操作仍须等待同一来源范围内的读取结束');
    await holder.query('ROLLBACK');
    assert.equal(typeof await service.createSession(scope),'string');
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${f.owner}`]);
    await assert.rejects(service.readCandidate(scope,session,generated.candidate),
      error => error instanceof AssistantDiscussionError && error.code==='unavailable',
      '来源写入或删除持锁期间仍不得发布读取结果');
    assert.equal((await readPublicReplyEvidence({runtimeOwnerId:f.owner,businessTransaction:transaction},
      `${f.storage.directory}/skills`,f.contact,generated.request)).status,503);
  } finally {
    await holder.query('ROLLBACK');
    await holder.end();
  }
});

test('渠道绑定建立后仍可读取既有手动确认生成，不把两种来源混用', async (t) => {
  const f = await fixture(t);
  const manual = randomUUID();
  await f.storage.client.query(
    'INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',
    [manual, f.owner, f.contact],
  );
  const scope = {owner_id:f.owner, contact_id:f.contact};
  const session = await f.service.defaultSession(scope);
  const generation = await completedGeneration(f, session, '合成手动候选', manual);

  const reopened = await f.service.readSession(scope, session);
  const turn = reopened.turns.find(item => item.turn_id === generation.turn);
  const input = reopened.inputs.find(item => item.input_version_id === generation.input);
  assert.equal(turn.state, 'completed');
  assert.equal(turn.reply.candidates[0].text, '合成手动候选');
  assert.equal(input.state, 'active');
  assert.equal(input.conversation_binding_id, manual);

  const stored = (await f.storage.client.query(
    'SELECT conversation_binding_id FROM assistant_session_turn WHERE id=$1',
    [generation.turn],
  )).rows[0];
  assert.equal(stored.conversation_binding_id, manual, '读取不能把手动来源改写成渠道绑定');
});

test('讨论重开、编辑选择、携入、中断与删除保持显式身份和幂等', async (t) => {
  const f = await fixture(t);
  const scope = {owner_id: f.owner, contact_id: f.contact};
  const source = await f.service.defaultSession(scope);
  const generation = await completedGeneration(f, source);

  const edited = await f.service.editCandidate(scope, source, generation.candidate, {
    edit_key: randomUUID(),
    parent_version_id: generation.candidate,
    messages: [{message_id: generation.message, text: '合成改写版本'}],
    requirements: '更自然',
  });
  assert.equal(edited.versions.at(-1).text, '合成改写版本');
  assert.equal(edited.selected_version_id, null, '编辑不能隐式选择');
  const replay = await f.service.editCandidate(scope, source, generation.candidate, {
    edit_key: edited.versions.at(-1).edit_key,
    parent_version_id: generation.candidate,
    messages: [{message_id: generation.message, text: '合成改写版本'}],
    requirements: '更自然',
  });
  assert.deepEqual(replay.versions, edited.versions, '同编辑键重复提交不得生成第二个版本');

  const selectionKey = randomUUID();
  const selection = await f.service.selectCandidate(
    scope, source, generation.candidate, edited.versions.at(-1).version_id, selectionKey,
  );
  assert.deepEqual(
    await f.service.selectCandidate(
      scope, source, generation.candidate, edited.versions.at(-1).version_id, selectionKey,
    ),
    selection,
  );

  const carried = await f.service.carryCandidate(scope, source, {
    expected_selection_id: selection.selection_id,
    candidate_id: generation.candidate,
    version_id: edited.versions.at(-1).version_id,
  });
  assert.notEqual(carried.session_id, source);
  const carryRow = (await f.storage.client.query(
    'SELECT content::text AS content FROM assistant_session_input WHERE id=$1',
    [carried.input_version_id],
  )).rows[0];
  assert.doesNotMatch(carryRow.content, /合成改写版本/, '携入只保存段身份，不复制候选正文');
  const reopened = await f.service.readSession(scope, carried.session_id);
  assert.deepEqual(reopened.inputs[0].content.messages, [{message_id: generation.message, text: '合成改写版本'}]);

  const running = randomUUID();
  const input = randomUUID();
  const requestKey = randomUUID();
  const request = randomUUID();
  await f.storage.client.query(
    `INSERT INTO reply_request(
       id,owner_id,contact_id,conversation_binding_id,idempotency_key,
       normalized_input,state,attempt,lease_expires_at
     ) VALUES($1,$2,$3,$4,$5,'synthetic','running',1,now()+interval '30 seconds')`,
    [request, f.owner, f.contact, f.binding, requestKey],
  );
  await f.storage.client.query(
    `INSERT INTO assistant_session_turn(
       id,session_id,owner_id,contact_id,input_version_id,idempotency_key,
       conversation_binding_id,input_digest,input_payload
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      running, source, f.owner, f.contact, input, requestKey, f.binding,
      'b'.repeat(64), JSON.stringify({content: {type: 'rewrite_draft'}}),
    ],
  );
  await f.storage.client.query(
    `INSERT INTO assistant_session_input(
       id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id
     ) VALUES($1,$2,$3,$4,$5,'generation',$6)`,
    [input, source, f.owner, f.contact, f.binding, running],
  );
  await f.storage.client.query(
    'UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',
    [source, input],
  );
  const interrupted = await f.service.interrupt(scope, source, requestKey, input, 'app_quit');
  assert.equal(interrupted.state, 'failed');
  assert.equal(interrupted.interruption_reason, 'app_quit');
  assert.deepEqual(
    await f.service.interrupt(scope, source, requestKey, input, 'app_quit'),
    interrupted,
  );
  assert.equal(
    (await f.storage.client.query(
      "SELECT count(*)::int AS n FROM reply_invalidated_key WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3",
      [f.owner, f.contact, requestKey],
    )).rows[0].n,
    1,
  );
  const cancelledTurn = randomUUID();
  const cancelledInput = randomUUID();
  const cancelledRequestKey = randomUUID();
  const cancelledRequest = randomUUID();
  await f.storage.client.query(
    `INSERT INTO reply_request(
       id,owner_id,contact_id,conversation_binding_id,idempotency_key,
       normalized_input,state,attempt,lease_expires_at
     ) VALUES($1,$2,$3,$4,$5,'synthetic','running',1,now()+interval '30 seconds')`,
    [cancelledRequest, f.owner, f.contact, f.binding, cancelledRequestKey],
  );
  await f.storage.client.query(
    `INSERT INTO reply_attempt(
       reply_request_id,number,state,started_at,lease_expires_at
     ) VALUES($1,1,'running',now(),now()+interval '30 seconds')`,
    [cancelledRequest],
  );
  await f.storage.client.query(
    `INSERT INTO assistant_session_turn(
       id,session_id,owner_id,contact_id,input_version_id,idempotency_key,
       conversation_binding_id,input_digest,input_payload
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      cancelledTurn, source, f.owner, f.contact, cancelledInput, cancelledRequestKey, f.binding,
      'c'.repeat(64), JSON.stringify({content: {type: 'rewrite_draft'}}),
    ],
  );
  await f.storage.client.query(
    `INSERT INTO assistant_session_input(
       id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id
     ) VALUES($1,$2,$3,$4,$5,'generation',$6)`,
    [cancelledInput, source, f.owner, f.contact, f.binding, cancelledTurn],
  );
  await f.storage.client.query(
    'UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',
    [source, cancelledInput],
  );
  const userCancelled = await f.service.interrupt(
    scope,
    source,
    cancelledRequestKey,
    cancelledInput,
    'user_cancelled',
  );
  assert.equal(userCancelled.state, 'failed');
  assert.equal(userCancelled.interruption_reason, 'user_cancelled');
  assert.deepEqual(
    (await f.storage.client.query(
      'SELECT state,failure_reason FROM reply_attempt WHERE reply_request_id=$1 ORDER BY number',
      [cancelledRequest],
    )).rows,
    [{ state: 'failed', failure_reason: 'user_cancelled' }],
  );
  assert.equal(
    (await f.storage.client.query(
      "SELECT count(*)::int AS n FROM reply_invalidated_key WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3",
      [f.owner, f.contact, cancelledRequestKey],
    )).rows[0].n,
    1,
  );

  await f.service.deleteSession(scope, source);
  await f.service.deleteSession(scope, source);
  await assert.rejects(() => f.service.readSession(scope, source), (error) =>
    error instanceof AssistantDiscussionError && error.code === 'not_found');
  const descendant = await f.service.readSession(scope, carried.session_id);
  const carriedInput = descendant.inputs.find(item => item.input_version_id === carried.input_version_id);
  assert.equal(carriedInput.state, 'unavailable');
  assert.equal(carriedInput.content, null, '源讨论删除后不得从携入元数据恢复候选正文');
  assert.equal(
    (await f.storage.client.query(
      'SELECT count(*)::int AS n FROM assistant_session_turn WHERE session_id=$1',
      [source],
    )).rows[0].n,
    0,
  );
});

test('跨 owner/contact 和过期版本不会通过猜测或旧快照恢复', async (t) => {
  const f = await fixture(t);
  const scope = {owner_id: f.owner, contact_id: f.contact};
  const session = await f.service.defaultSession(scope);
  const generation = await completedGeneration(f, session);
  await assert.rejects(
    () => f.service.readSession({...scope, owner_id: randomUUID()}, session),
    (error) => error instanceof AssistantDiscussionError && error.code === 'not_found',
  );
  await assert.rejects(
    () => f.service.editCandidate(scope, session, generation.candidate, {
      edit_key: randomUUID(),
      parent_version_id: randomUUID(),
      messages: [{message_id: generation.message, text: '不应保存'}],
    }),
    (error) => error instanceof AssistantDiscussionError && error.code === 'not_found',
  );
  assert.equal(
    (await f.storage.client.query(
      'SELECT count(*)::int AS n FROM assistant_candidate_version WHERE session_id=$1 AND version_number>0',
      [session],
    )).rows[0].n,
    0,
  );
});

test('讨论输入超过边界或旧版本提交时拒绝，不截断、不摘要且不改当前输入', async (t) => {
  const f = await fixture(t);
  const scope = {owner_id: f.owner, contact_id: f.contact};
  const session = await f.service.defaultSession(scope);
  const first = await f.service.recordInput(scope, session, {
    type: 'purpose_exploration', purpose_hint: '先保留完整讨论',
  });
  const second = await f.service.recordInput(scope, session, {
    type: 'purpose_exploration', purpose_hint: '用户明确改口',
  }, first);
  await assert.rejects(
    () => f.service.recordInput(scope, session, {
      type: 'purpose_exploration', purpose_hint: '基于旧版本的迟到输入',
    }, first),
    (error) => error instanceof AssistantDiscussionError
      && error.code === 'conflict'
      && error.reason === 'assistant_session_input_conflict',
  );
  await assert.rejects(
    () => f.service.recordInput(scope, session, {
      type: 'purpose_exploration', purpose_hint: '长'.repeat(4097),
    }, second),
    (error) => error instanceof AssistantDiscussionError && error.code === 'invalid',
  );
  const stored = (await f.storage.client.query(
    `SELECT current_input_version_id,input.id
       FROM assistant_session
       JOIN assistant_session_input input ON input.session_id=assistant_session.id
      WHERE assistant_session.id=$1
      ORDER BY input.created_at,input.id`,
    [session],
  )).rows;
  assert.equal(stored.length, 2);
  assert.ok(stored.every(row => row.current_input_version_id === second));
  assert.equal(await f.service.selectedCandidate(scope, session), null);
  const learning = (await f.storage.client.query(
    `SELECT (SELECT count(*)::int FROM confirmed_memory) AS memories,
            (SELECT count(*)::int FROM expression_preference) AS preferences,
            (SELECT count(*)::int FROM skill_draft) AS drafts`,
  )).rows[0];
  assert.deepEqual(learning, {memories: 0, preferences: 0, drafts: 0});
});

test('讨论来源清理后重开只显示不可用占位，不恢复原文', async (t) => {
  const f = await fixture(t);
  const scope = {owner_id: f.owner, contact_id: f.contact};
  const source = randomUUID();
  const message = randomUUID();
  await f.storage.client.query(
    `INSERT INTO source_document(
       id,owner_id,contact_id,source_type,file_name,content_sha256,record_count
     ) VALUES($1,$2,$3,'manual','合成来源',$4,1)`,
    [source, f.owner, f.contact, source.replaceAll('-', '').repeat(2)],
  );
  await f.storage.client.query(
    `INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
     VALUES($1,$2,$3,'contact','text','合成待删原话','2026-01-01T01:02:03.123456Z')`,
    [message, f.owner, f.contact],
  );
  await f.storage.client.query(
    `INSERT INTO message_source_ref(
       id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload
     ) VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')`,
    [randomUUID(), message, f.owner, f.contact, source],
  );
  const session = await f.service.defaultSession(scope);
  const input = await f.service.recordInput(scope, session, {
    type: 'response_exploration', target_message_id: message,
  });
  assert.equal((await f.service.readSession(scope, session)).inputs[0].state, 'active');
  await f.transaction(client =>
    deleteSourceReplies(client, f.owner, [source, message], f.contact, false));
  const reopened = await f.service.readSession(scope, session);
  const cleaned = reopened.inputs.find(item => item.input_version_id === input);
  assert.equal(cleaned.state, 'redacted');
  assert.equal(cleaned.content, null);
  assert.equal(cleaned.placeholder, '相关来源已删除');
  assert.equal((await f.storage.client.query(
    'SELECT state,content FROM assistant_session_input WHERE id=$1',
    [input],
  )).rows[0].content, null);
});

test('讨论删除使在途保存失效，并清理学习依赖和可恢复更新备份', async (t) => {
  const f = await fixture(t);
  const scope = {owner_id: f.owner, contact_id: f.contact};
  const session = await f.service.defaultSession(scope);
  const turn = randomUUID();
  const input = randomUUID();
  const requestKey = randomUUID();
  const requestId = randomUUID();
  const lease = new Date(Date.now() + 30000);
  await f.storage.client.query(
    `INSERT INTO reply_request(
       id,owner_id,contact_id,conversation_binding_id,idempotency_key,
       normalized_input,state,attempt,lease_expires_at
     ) VALUES($1,$2,$3,$4,$5,'synthetic','running',1,$6)`,
    [requestId, f.owner, f.contact, f.binding, requestKey, lease],
  );
  await f.storage.client.query(
    `INSERT INTO assistant_session_turn(
       id,session_id,owner_id,contact_id,input_version_id,idempotency_key,
       conversation_binding_id,input_digest,input_payload
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      turn, session, f.owner, f.contact, input, requestKey, f.binding,
      'c'.repeat(64), JSON.stringify({content: {type: 'rewrite_draft'}}),
    ],
  );
  await f.storage.client.query(
    `INSERT INTO assistant_session_input(
       id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id
     ) VALUES($1,$2,$3,$4,$5,'generation',$6)`,
    [input, session, f.owner, f.contact, f.binding, turn],
  );
  await f.storage.client.query(
    'UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',
    [session, input],
  );

  const task = randomUUID();
  const draft = randomUUID();
  const batch = randomUUID();
  const material = randomUUID();
  await f.storage.client.query(
    `INSERT INTO background_task(id,owner_id,contact_id,task_type,current_step,message_count)
     VALUES($1,$2,$3,'skill_learning','propose_skill',1)`,
    [task, f.owner, f.contact],
  );
  await f.storage.client.query(
    `INSERT INTO skill_draft(
       id,owner_id,contact_id,logical_skill_id,proposal_kind,
       strategy,private_evidence,batch_key,dependency_ids
     ) VALUES($1,$2,$3,$4,'create','{}','{}','synthetic',$5)`,
    [draft, f.owner, f.contact, randomUUID(), [session]],
  );
  await f.storage.client.query(
    `INSERT INTO skill_learning_batch(
       id,owner_id,contact_id,task_id,batch_key,outcome,draft_id,dependency_ids
     ) VALUES($1,$2,$3,$4,'synthetic','draft',$5,$6)`,
    [batch, f.owner, f.contact, task, draft, [session]],
  );
  await f.storage.client.query(
    `INSERT INTO skill_learning_receipt(owner_id,contact_id,material_id,digest,batch_id)
     VALUES($1,$2,$3,$4,$5)`,
    [f.owner, f.contact, material, 'd'.repeat(64), batch],
  );

  const managedRoot = join(f.storage.directory, 'managed-delete');
  const archive = join(managedRoot, 'updates', randomUUID());
  const identity = (await f.storage.client.query(
    `SELECT system_identifier::text,d.oid,d.datname,d.datdba
       FROM pg_catalog.pg_control_system(),pg_catalog.pg_database d
      WHERE d.datname=pg_catalog.current_database()`,
  )).rows[0];
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([identity.system_identifier, identity.oid, identity.datname, identity.datdba]))
    .digest('hex');
  await mkdir(join(managedRoot, 'managed'), {recursive: true, mode: 0o700});
  await mkdir(archive, {recursive: true, mode: 0o700});
  await writeFile(
    join(managedRoot, 'managed', 'state.json'),
    JSON.stringify({formatVersion: 1, bootstrapComplete: true}),
    {mode: 0o600},
  );
  await writeFile(join(archive, 'checkpoint.json'), JSON.stringify({
    format_version: 1, destination_fingerprint: fingerprint, activation_complete: true,
    phase: 'complete', restore_verified: true, connection_gate: false, source_gate: false,
  }), {mode: 0o600});
  await writeFile(join(archive, 'database.dump'), '仅合成备份', {mode: 0o600});
  f.environment.NOTALONE_MANAGED_USER_DATA = managedRoot;

  const store = new PostgresReplyStore({
    transaction: f.transaction,
    guards: {
      start: async () => {},
      started: async () => {},
      prepare: async () => {},
      commit: async () => {},
      replay: async () => {},
    },
  });
  const expected = {session_id: session, state: 'deleted'};
  assert.deepEqual(await f.service.deleteSession(scope, session), expected);
  assert.deepEqual(await f.service.deleteSession(scope, session), expected);
  await assert.rejects(access(join(archive, 'database.dump')));
  await access(join(archive, 'checkpoint.json'));
  const state = (await f.storage.client.query(
    `SELECT (SELECT status FROM skill_draft WHERE id=$1) AS draft,
            (SELECT outcome FROM skill_learning_batch WHERE id=$2) AS batch,
            (SELECT digest FROM skill_learning_receipt WHERE material_id=$3) AS digest,
            (SELECT status FROM background_task WHERE id=$4) AS task,
            (SELECT count(*)::int FROM reply_invalidated_key
              WHERE owner_id=$5 AND contact_id=$6 AND idempotency_key=$7) AS invalidated`,
    [draft, batch, material, task, f.owner, f.contact, requestKey],
  )).rows[0];
  assert.deepEqual(state, {
    draft: 'invalidated', batch: 'invalidated', digest: null,
    task: 'cancelled', invalidated: 1,
  });
  assert.equal((await f.storage.client.query(
    'SELECT count(*)::int AS n FROM reply_request WHERE id=$1',
    [requestId],
  )).rows[0].n, 0);

  const evidence = randomUUID();
  await assert.rejects(store.save({
    request_id: requestId, owner_id: f.owner, contact_id: f.contact,
    conversation_binding_id: f.binding, idempotency_key: requestKey,
    normalized_input: 'synthetic', continued_from_candidate_id: null,
    attempt: 1, lease_expires_at: lease,
  }, {
    evidence: [{
      evidence_id: evidence, kind: 'user_draft', text: '合成未提交候选',
      source_ids: [], selection_reason: 'synthetic', status: 'active',
    }],
    snapshot: {scope},
    skill_library_revision: 0,
  }, [{
    candidate_id: randomUUID(), text: '迟到候选', basis: '合成依据',
    citation_ids: [evidence], risk_notes: [],
    messages: [{message_id: randomUUID(), text: '迟到候选'}],
  }]), {code: 'reply_input_invalidated'});
  assert.equal((await f.storage.client.query(
    'SELECT count(*)::int AS n FROM reply_candidate WHERE reply_request_id=$1',
    [requestId],
  )).rows[0].n, 0);
});
