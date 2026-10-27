import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { lifecycleHost } from '../../../backend-ts/test/memory-lifecycle-host-support.mjs';
import { fixture, ids } from '../layered-memory/support.mjs';
import { withMemoryPage } from '../layered-memory/react-support.mjs';

// 合成响应只替代供应商出站边界；轮次接纳、任务、核验与结束由正式宿主执行。
test('真实记忆页继续固定一轮，零候选仍完成全部必要阶段且不伪造画像', { timeout: 90000 }, async t => {
  let calls = 0;
  const provider = createServer(async (request, response) => {
    calls++;
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const events = [
      { type: 'message_start', message: { id: 'synthetic-empty', model: 'deepseek-chat', usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'synthetic-empty-tool', name: input.tools[0].name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"scenes":[]}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const host = await lifecycleHost(t, async (f, owner) => {
    const source = randomUUID(), message = randomUUID(), scope = randomUUID(), round = randomUUID(), task = randomUUID();
    await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$3,'合成完整轮次'),($2,$3,'合成隔离')", [ids.contact, ids.other, owner]);
    await f.client.query("INSERT INTO memory_processing_scope(id,owner_id,contact_id,intent,control_generation) VALUES($1,$2,$3,'pause',1)", [scope, owner, ids.contact]);
    await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase) VALUES($1,$2,$3,$4,1,1,'waiting','extraction')", [round, scope, owner, ids.contact]);
    await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2', [round, scope]);
    await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic-round.jsonl',$4,1)", [source, owner, ids.contact, 'd'.repeat(64)]);
    await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成资料：今天去散步。','2026-10-20T01:00:00Z')", [message, owner, ids.contact]);
    await f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic:1',$5)", [message, owner, ids.contact, source, { time_iso: '2026-10-20T01:00:00Z' }]);
    await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,$4,'import','queued','extract_memory',1)", [task, owner, ids.contact, source]);
    await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,total_count) VALUES($1,'parse',1,'succeeded',1),($1,'normalize',2,'succeeded',1),($1,'extract_memory',3,'pending',1),($1,'index',4,'pending',1),($1,'verify',5,'pending',1)", [task]);
    await f.client.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3)', [task, owner, ids.contact]);
    await f.client.query('INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id) VALUES($1,$2,$3,$4)', [task, message, owner, ids.contact]);
    await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)', [round, task, owner, ids.contact]);
    await f.client.query('INSERT INTO memory_processing_round_target(round_id,task_id,message_id) VALUES($1,$2,$3)', [round, task, message]);
    await f.client.query("UPDATE memory_processing_round SET target_unit='messages',target_count=1 WHERE id=$1", [round]);
  }, { providerUrl: `http://127.0.0.1:${provider.address().port}` });
  const f = await fixture(async request => {
    const result = await host.request(request.path, { method: request.method, body: request.body });
    assert.equal(result.status, 200, '页面请求必须通过正式认证合同');
    return { generation: 1, data: result.data };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '关系资料处理状态' });
    await card.getByRole('status').filter({ hasText: /^已暂停$/ }).waitFor();
    await card.getByRole('button', { name: '继续处理', exact: true }).click();
    await card.getByRole('status').filter({ hasText: /^已完成$/ }).waitFor({ timeout: 12000 });
    assert.equal(await page.getByRole('region', { name: '当前联系人后台任务' }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '关系资料处理状态' }).count(), 1);
    assert.equal((await host.request(`/api/contacts/${ids.contact}/memory-processing/state`)).data.current.status, 'completed');
    assert.equal((await host.request(`/api/contacts/${ids.contact}/layered-memory`)).data.layered_memory.profile, null);
    assert.equal(calls, 1, '零候选只结算真实提取调用，不虚构主题和画像调用');
  });
});
