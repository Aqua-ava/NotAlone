import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lifecycleHost } from '../../../backend-ts/test/memory-lifecycle-host-support.mjs';
import { fixture, ids } from '../layered-memory/support.mjs';
import { withMemoryPage } from '../layered-memory/react-support.mjs';

// 仅合成准备写隔离库；页面沿正式认证 HTTP、生产控制器与 preload 读取真实投影。
test('真实记忆页经正式profile认证HTTP读取同一范围状态与历史，本人不混入联系人任务', { timeout: 90000 }, async t => {
  const scope = randomUUID(), round = randomUUID(), task = randomUUID();
  const host = await lifecycleHost(t, async (f, owner) => {
    await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$3,'合成页面一'),($2,$3,'合成页面二')", [ids.contact, ids.other, owner]);
    await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,$3)', [scope, owner, ids.contact]);
    await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status) VALUES($1,$2,$3,$4,1,0,'completed')", [round, scope, owner, ids.contact]);
    await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2', [round, scope]);
    await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'layered_memory','succeeded','organize_memory',0)", [task, owner, ids.contact]);
    await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)', [round, task, owner, ids.contact]);
    for (let i = 0; i < 21; i++) await f.client.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count,last_error_code,updated_at) VALUES($1,$2,'layered_memory','failed','organize_memory',0,'synthetic_legacy_error',now()-$3::int*interval '1 second')", [owner, ids.contact, i + 1]);
  });
  const paths = [];
  const f = await fixture(async request => {
    assert.equal(request.method, 'GET', '本票页面只允许读取，不提交执行动作');
    paths.push(request.path);
    const result = await host.request(request.path);
    if (result.status < 200 || result.status >= 300) throw new Error('合成页面HTTP读取失败');
    return { generation: 1, data: result.data };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '关系资料处理状态' });
    await card.getByRole('status').filter({ hasText: /^已完成$/ }).waitFor();
    assert.equal(await page.getByRole('region', { name: '当前联系人后台任务' }).count(), 0);
    assert.equal(await card.getByText('synthetic_legacy_error', { exact: false }).count(), 0);
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    const history = card.getByRole('group', { name: '处理历史' });
    assert.equal(await history.getAttribute('open'), null);
    await history.locator('summary').click();
    assert.equal(await history.locator('article').count(), 20);
    await history.getByRole('button', { name: '加载更多历史' }).click();
    await history.locator('article').nth(21).waitFor();
    assert.equal(await history.locator('article').count(), 22);
    assert.equal(await card.getByRole('status').innerText(), '已完成');
    await page.getByRole('button', { name: '我', exact: true }).click();
    await card.getByRole('status').filter({ hasText: /^等待处理$/ }).waitFor();
    await card.getByText('暂无待处理资料。', { exact: true }).waitFor();
    assert.ok(paths.includes('/api/owner/memory-processing/state'));
    assert.ok(paths.some(path => path.includes('/memory-processing/history?cursor=')));
    assert.equal(paths.some(path => path.startsWith('/api/tasks')), false);
  });
  assert.equal((await host.request('/api/runtime/status')).data.taskWorker.state, 'running');
});
