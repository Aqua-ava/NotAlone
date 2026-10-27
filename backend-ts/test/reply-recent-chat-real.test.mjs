import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { PostgresReplyContext } from '../src/reply/context/reply-context.ts';
import { parseReplyRequest } from '../src/reply/generation/reply-contract.ts';
import { buildReplyPayload } from '../src/reply/generation/reply-payload.ts';
import { createEvidenceAliases } from '../src/reply/generation/reply-evidence-alias.ts';

// 仅在显式提供仓库外私有真实资料时运行；不发送模型请求，不保存聊天正文到测试结果。
const fixturePath = process.env.NOTALONE_REAL_REPLY_FIXTURE;
test('真实聊天的近期提示保留来源、时间边界和完整正文', { skip: !fixturePath }, async t => {
  assert.ok(isAbsolute(fixturePath), '真实资料路径必须是绝对路径');
  const input = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.ok(Array.isArray(input.messages) && input.messages.length >= 11);
  const f = await createStorageFixture();
  t.after(() => f.close());
  const owner = randomUUID(), contact = randomUUID(), binding = randomUUID(), source = randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'测试本人')", [owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'测试联系人')", [contact, owner]);
  await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)', [binding, owner, contact]);
  await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','私有测试来源',$4,1)", [source, owner, contact, 'a'.repeat(64)]);
  for (const message of input.messages) {
    const id = randomUUID(), speaker = { owner: 'user', contact: 'contact', system: 'system' }[message.speaker];
    assert.ok(speaker && typeof message.text === 'string' && message.text.trim());
    await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,$4,'text',$5,$6)", [id, owner, contact, speaker, message.text, message.time]);
    await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,$6,'{}')", [randomUUID(), id, owner, contact, source, id]);
  }
  const inputFor = (action, text = '') => parseReplyRequest({ contact_id: contact, idempotency_key: randomUUID(),
    content: { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: action, draft_text: text, include_relationship_context: true }, skill_disabled: true });
  const request = inputFor('suggest');
  const context = await new PostgresReplyContext(f.client, { overview: false }).build({ owner_id: owner, contact_id: contact,
    conversation_binding_id: binding, reply_request_id: randomUUID(), request });
  const build = (ctx, command = request) => buildReplyPayload({ request: command, context: ctx, aliases: createEvidenceAliases() });
  const sort = ctx => ctx.evidence.filter(e => e.kind === 'message').sort((a, b) => Date.parse(a.timing.source_started_at) - Date.parse(b.timing.source_started_at));
  const original = () => structuredClone(context);
  const payload = build(context), messages = payload.evidence.filter(e => e.kind === 'message');
  assert.equal(messages.length, Math.min(input.messages.length, 50));
  assert.equal(payload.recent_chat.messages.length, 10, '样例的最近时间需要足够多且无窗口边界并列');
  assert.deepEqual(payload.recent_chat.messages.map(e => e.evidence_id), messages.slice(-10).map(e => e.evidence_id));
  assert.ok(payload.recent_chat.messages.slice(-2).every((e, i) => e.text === messages.slice(-2)[i].text), '近期提示应保留最新正文');

  // 修改隔离内存副本的时间，使用同一真实消息检验跨时区同一瞬间的边界。
  const tied = original(), ordered = sort(tied), boundary = ordered.at(-10).timing.source_started_at;
  ordered.at(-11).timing.source_started_at = new Date(boundary).toISOString();
  const tiedPayload = build(tied);
  assert.equal(tiedPayload.recent_chat.messages.length, 9);
  assert.ok(tiedPayload.recent_chat.messages.every(e => Date.parse(e.occurred_at) !== Date.parse(boundary)));

  // 相差一微秒不是同一时刻；不能用 JavaScript 毫秒时间把边界两条当作并列。
  const precise = original(), orderedPrecise = sort(precise);
  const second = new Date(orderedPrecise.at(-10).timing.source_started_at).toISOString().replace(/\.\d{3}Z$/, '');
  orderedPrecise.at(-11).timing.source_started_at = `${second}.000001Z`;
  orderedPrecise.at(-10).timing.source_started_at = `${second}.000002Z`;
  const precisePayload = build(precise);
  assert.equal(precisePayload.recent_chat.messages.length, 10);
  assert.equal(precisePayload.recent_chat.messages[0].occurred_at, `${second}.000002Z`);

  const unknown = original(), unknownMessage = sort(unknown).at(-1);
  unknownMessage.timing.source_started_at = null;
  unknownMessage.timing.source_ended_at = null;
  const unknownPayload = build(unknown);
  assert.ok(!unknownPayload.recent_chat.messages.some(e => e.text === unknownMessage.text));
  assert.ok(unknownPayload.evidence.some(e => e.text === unknownMessage.text));

  const large = original(), orderedLarge = sort(large), longest = orderedLarge.reduce((a, b) => a.text.length > b.text.length ? a : b), peer = orderedLarge.at(-1);
  assert.ok([...longest.text].length > 512, '样例需有一条超过 512 字的真实消息');
  longest.timing.source_started_at = new Date(peer.timing.source_started_at).toISOString();
  const largePayload = build(large), group = largePayload.recent_chat.messages.filter(e => Date.parse(e.occurred_at) === Date.parse(peer.timing.source_started_at));
  assert.equal(group.length, 2);
  assert.ok(group.every(e => !('text' in e) && e.text_location === '完整正文见 evidence'));
  assert.ok(largePayload.evidence.some(e => e.text === longest.text), '原始证据须保持完整');
  assert.ok(largePayload.recent_chat.messages.reduce((n, e) => n + [...(e.text ?? '')].length, 0) <= 2048);

  const olderRequest = inputFor('suggest', '请继续之前的话题');
  assert.equal(build(context, olderRequest).draft_text, olderRequest.content.draft_text);
  const express = inputFor('express', messages.at(-1).text);
  assert.equal(build(context, express).recent_chat, undefined);
});
