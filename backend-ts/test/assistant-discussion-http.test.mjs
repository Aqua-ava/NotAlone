import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {AssistantDiscussionService} from '../src/reply/discussion/assistant-discussion-service.ts';
import {createAssistantDiscussionHttp} from '../src/reply/discussion/assistant-discussion-http.ts';

test('讨论内部入口严格认证且重开/删除只返回已保存业务状态', async (t) => {
  const f = await createStorageFixture();
  t.after(() => f.close());
  const owner = randomUUID();
  const contact = randomUUID();
  const binding = randomUUID();
  const token = randomUUID() + randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')", [owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')", [contact, owner]);
  await f.client.query(
    "INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic','fixture')",
    [binding, owner, contact],
  );
  const service = new AssistantDiscussionService({
    transaction: async (work) => {
      await f.client.query('BEGIN');
      try {
        const result = await work(f.client);
        await f.client.query('COMMIT');
        return result;
      } catch (error) {
        await f.client.query('ROLLBACK');
        throw error;
      }
    },
    skillsRoot: `${f.directory}/skills`,
  });
  const changed = [];
  const endpoint = createAssistantDiscussionHttp({ownerId: owner, token, service,
    onChanged: scope => changed.push(scope)});
  const server = createServer((req, res) => endpoint.handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = `http://127.0.0.1:${server.address().port}/internal/discussion`;
  const request = async (body, authorization = `Bearer ${token}`) => {
    const response = await fetch(address, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization},
      body: JSON.stringify(body),
    });
    return {status: response.status, body: await response.json()};
  };

  assert.equal((await request({
    owner_id: owner, contact_id: contact, action: 'default', request: {},
  }, 'Bearer wrong')).status, 401);
  const created = await request({
    owner_id: owner, contact_id: contact, action: 'default', request: {},
  });
  assert.equal(created.status, 200);
  const sessionId = created.body.result.session_id;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const another = await request({
    owner_id: owner, contact_id: contact, action: 'new', request: {},
  });
  assert.equal(another.status, 200);
  assert.notEqual(another.body.result.session_id, sessionId);
  const reopened = await request({
    owner_id: owner, contact_id: contact, session_id: sessionId, action: 'read', request: {},
  });
  assert.deepEqual(reopened.body.result, {
    session_id: sessionId, current_input_version_id: null, turns: [], inputs: [],
  });
  const removed = await request({
    owner_id: owner, contact_id: contact, session_id: sessionId,
    action: 'delete', request: {confirmed: true},
  });
  assert.deepEqual(removed.body.result, {session_id: sessionId, state: 'deleted'});
  const missing = await request({
    owner_id: owner, contact_id: contact, session_id: sessionId, action: 'read', request: {},
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not_found');
  const cancellation = await request({
    owner_id: owner, contact_id: contact, session_id: randomUUID(), action: 'interrupt',
    request: {request_key: randomUUID(), input_version_id: randomUUID(), reason: 'user_cancelled'},
  });
  assert.equal(cancellation.status, 404, 'user_cancelled 必须通过动作字段校验并到达业务服务。');
  const invalidCancellation = await request({
    owner_id: owner, contact_id: contact, session_id: randomUUID(), action: 'interrupt',
    request: {request_key: randomUUID(), input_version_id: randomUUID(), reason: 'unknown'},
  });
  assert.equal(invalidCancellation.status, 400);
  assert.deepEqual(changed, [{owner_id: owner, contact_id: contact}]);
});
