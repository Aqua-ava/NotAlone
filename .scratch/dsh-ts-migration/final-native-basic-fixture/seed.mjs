// 仅由 prepare 调用；全部对象均为独立测试库中的明确合成资料。
import {randomUUID, createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {captureSnapshot} from '../../../backend-ts/src/contact-overview-evidence.ts';
import {MemoryService} from '../../../backend-ts/src/memory-service.ts';
import {AssistantDiscussionService} from '../../../backend-ts/src/assistant-discussion-service.ts';

export async function seed(client, storage, directory) {
  const owner = storage.runtimeOwnerId;
  const account = 'wxid_synthetic_native_owner';
  await client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat',$2,'合成验收本人')", [owner, account]);
  await client.query('INSERT INTO front_sync_state(owner_id,enabled) VALUES($1,false)', [owner]);
  await client.query("INSERT INTO wechat_sync_scope(owner_id,channel,account_scope,mode) VALUES($1,'wechat',$2,'selected')", [owner, account]);
  const contacts = [];
  for (const [letter, name] of [['a', '合成验收甲'], ['b', '合成验收乙']]) {
    const id = randomUUID(), binding = randomUUID(), externalId = `wxid_synthetic_native_${letter}`;
    await client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)', [id, owner, name]);
    await client.query("INSERT INTO channel_identity(owner_id,contact_id,channel,external_id,observed_name) VALUES($1,$2,'wechat',$3,$4)", [owner, id, externalId, name]);
    await client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,display_name) VALUES($1,$2,$3,'wechat',$4,$5,$6)", [binding, owner, id, account, externalId, name]);
    const source = randomUUID();
    const bodies = letter === 'a' ? ['合成验收甲喜欢青色便签。', '合成验收甲喜欢折纸。'] : ['合成验收乙喜欢方形书签。'];
    const records = bodies.map((text, index) => ({
      id: {local_id: index + 1, talker: externalId, server_id_str: `synthetic-seed-${letter}-${index + 1}`},
      kind: 'text', is_from_me: false, sender_wxid: externalId, sender: name, text,
      create_time: 1792454400 + index, time_iso: `2026-10-20T10:40:0${index}+08:00`,
      time: `2026-10-20 10:40:0${index}`,
    }));
    const raw = records.map(row => JSON.stringify(row)).join('\n') + '\n';
    const filename = `synthetic-seed-${letter}.jsonl`;
    await writeFile(join(directory, filename), raw, {mode: 0o600});
    await client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl',$4,$5,$6)", [source, owner, id, filename, createHash('sha256').update(raw).digest('hex'), records.length]);
    const messages = [];
    for (const [index, row] of records.entries()) {
      const message = randomUUID(); messages.push(message);
      await client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,$5)", [message, owner, id, row.text, row.time_iso]);
      await client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,$5,$6)", [message, owner, id, source, `line:${index + 1}`, row]);
    }
    const imported = [
      {id: {local_id: 101, talker: externalId, server_id_str: `synthetic-import-${letter}-101`}, kind: 'text', is_from_me: false, sender: name, sender_wxid: externalId, text: `${name}：合成文件补充记录。`, create_time: 1792548000, time_iso: '2026-10-21T10:00:00+08:00', time: '2026-10-21 10:00:00'},
      {id: {local_id: 102, talker: externalId, server_id_str: `synthetic-import-${letter}-102`}, kind: 'text', is_from_me: true, sender: '合成验收本人', sender_wxid: account, text: '合成本人：这只是合成导入验收。', create_time: 1792548060, time_iso: '2026-10-21T10:01:00+08:00', time: '2026-10-21 10:01:00'},
    ];
    const importFile = join(directory, `synthetic-import-${letter}.jsonl`);
    await writeFile(importFile, imported.map(row => JSON.stringify(row)).join('\n') + '\n', {mode: 0o600});
    contacts.push({id, binding, externalId, name, source, messages, importFile});
  }
  const [a, b] = contacts;
  const autoMemory = randomUUID(), candidate = randomUUID();
  await client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,$3,'合成验收甲喜欢青色便签。','preference',$4,'auto')", [autoMemory, owner, a.id, [a.messages[0]]]);
  const evidence = await captureSnapshot(client, owner, [a.messages[1]], [a.messages[1]], a.id);
  await client.query("INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,subject,source_ids,correction_evidence) VALUES($1,$2,$3,'合成验收甲喜欢折纸。','preference','contact',$4,$5)", [candidate, owner, a.id, [a.messages[1]], evidence]);
  const memory = new MemoryService(storage);
  const manual = (await memory.handle('POST', new URL('http://localhost/api/memories/manual-contact'), {
    contact_id: b.id, text: '合成验收乙的独立手动资料。', category: 'relationship_note',
  })).memory.memory_id;
  const discussion = new AssistantDiscussionService({
    transaction: work => storage.businessTransaction(work), skillsRoot: join(directory, 'skills'),
    environment: {HOME: directory, NOTALONE_MANAGED_USER_DATA: directory},
  });
  const scope = {owner_id: owner, contact_id: a.id};
  const session = await discussion.createSession(scope);
  await discussion.recordInput(scope, session, {
    type: 'purpose_exploration', purpose_hint: '合成验收甲：商量折纸活动（预置讨论，未调用模型）。',
    requirements: '仅为合成读取和删除验收，没有外部发送。', skill_mode: 'disabled',
  });
  return {owner, account, contacts, autoMemory, candidate, manual, discussion: session};
}
