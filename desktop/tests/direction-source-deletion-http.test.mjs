import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

// 经公开桥确认模型建议，再编辑并真实删除来源，不直接设置内部依赖标记。
for (const mode of ['reply_to_message', 'initiate_conversation']) {
  for (const scenario of ['当前联系人', '后台联系人', '当前联系人跨模式独立输入', '后台联系人跨模式独立输入']) test(`${mode}删除来源清理派生意愿：${scenario}`, async (t) => {
    const background = scenario.startsWith('后台联系人');
    const crossMode = scenario.endsWith('跨模式独立输入');
    const f = await budgetPublicFixture(t);
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode });
    if (mode === 'reply_to_message') {
      await f.bridge.loadMessages({ ...scope, older: false });
      await f.bridge.selectMessage({ ...scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
    } else await f.bridge.updatePurpose({ ...scope, purpose: '想了解合成近况。' });
    const marker = '合成来源派生意愿，表示愿意等待。';
    await f.command('plan', { plan: { explore: { direction: marker } } });
    await f.bridge.explore(scope);
    const result = (await f.bridge.getState()).exploration.result;
    assert.ok(result, '方向探索应成功');
    await f.bridge.selectDirection({ ...scope, inputVersion: result.inputVersion, suggestionId: result.directions[0].suggestionId });
    const field = mode === 'reply_to_message' ? 'direction' : 'purpose';
    assert.equal((await f.bridge.getState())[field], marker);
    const edited = `${marker} 用户追加本次措辞。`;
    if (mode === 'reply_to_message') await f.bridge.updateDirection({ ...scope, direction: edited });
    else await f.bridge.updatePurpose({ ...scope, purpose: edited });
    assert.equal((await f.bridge.getState())[field], edited);
    const independentField = mode === 'reply_to_message' ? 'purpose' : 'direction';
    const independent = '用户在另一模式独立手写的内容。';
    if (crossMode) {
      await f.bridge.setMode({ ...scope, mode: mode === 'reply_to_message' ? 'initiate_conversation' : 'reply_to_message' });
      if (independentField === 'purpose') await f.bridge.updatePurpose({ ...scope, purpose: independent });
      else {
        await f.bridge.loadMessages({ ...scope, older: false });
        await f.bridge.selectMessage({ ...scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
        await f.bridge.updateDirection({ ...scope, direction: independent });
      }
    }
    if (background) {
      await f.connect(f.data.contact_ids[1]);
      await f.connect(scope.contactId);
      assert.equal((await f.bridge.getState())[field], edited);
      await f.connect(f.data.contact_ids[1]);
    }
    const sources = await f.request(`/api/contacts/${scope.contactId}/sources`);
    const sourceId = sources.sources[0].source_id;
    await f.request(`/api/contacts/${scope.contactId}/sources/${sourceId}`, undefined, 'DELETE');
    const deadline = Date.now() + 10000;
    let deleted = false;
    while (Date.now() < deadline) {
      const source = (await f.request(`/api/contacts/${scope.contactId}/sources`)).sources.find((item) => item.source_id === sourceId);
      if (source.status === 'deleted' && source.task_status === 'succeeded') { deleted = true; break; }
      assert.notEqual(source.task_status, 'failed');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(deleted);
    await f.replies.revalidateDeletedSource(scope.contactId);
    if (background) await f.connect(scope.contactId);
    assert.equal((await f.bridge.getState())[field], '');
    await f.connect(f.data.contact_ids[1]);
    await f.connect(scope.contactId);
    assert.equal((await f.bridge.getState())[field], '');
    if (crossMode) assert.equal((await f.bridge.getState())[independentField], independent);
    assert.equal((await f.command('metrics')).model_calls, 1);
  });
}
