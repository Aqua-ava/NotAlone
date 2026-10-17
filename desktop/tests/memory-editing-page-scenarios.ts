import { expect, type Page } from '@playwright/test';
import type { MemoryFixture } from './memory-backend-fixture';

// 首片只核验本人资料修正；通过公开控件操作并从真实 HTTP 核对新版本。
export async function memoryOwnerCorrection(manager: Page, fixture: MemoryFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const owner = manager.getByRole('region', { name: '本人记忆', exact: true });
  await expect(owner.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  const before = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  expect(before.status).toBe(200);
  const previous = (before.data.memories as Array<Record<string, unknown>>)
    .find((item) => item.text === '本人喜欢合成绿茶。')!;
  await owner.getByRole('button', { name: '修正资料：本人喜欢合成绿茶。', exact: true }).click();
  const form = owner.getByRole('form', { name: '修正本人资料', exact: true });
  await form.getByRole('textbox', { name: '资料正文', exact: true }).fill('本人改为喜欢合成白茶。');
  await form.getByRole('combobox', { name: '资料分类', exact: true }).selectOption('preference');
  await form.getByRole('button', { name: '保存修正', exact: true }).click();
  await expect(owner.getByText('本人改为喜欢合成白茶。', { exact: true })).toBeVisible();
  await expect(owner.getByText('本人喜欢合成绿茶。', { exact: true })).toHaveCount(0);
  await owner.getByRole('button', { name: '查看来源与版本：本人改为喜欢合成白茶。', exact: true }).click();
  const corrected = owner.getByRole('article').filter({ has: manager.getByText('本人改为喜欢合成白茶。', { exact: true }) });
  await expect(corrected.getByText('手动采纳', { exact: true })).toBeVisible();
  await expect(corrected.getByText('版本：2 · 已采纳', { exact: true })).toBeVisible();
  await expect(corrected.getByText(`替代版本引用：${previous.memory_id}`, { exact: true })).toBeVisible();
  const after = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  expect(after.status).toBe(200);
  const memories = after.data.memories as Array<Record<string, unknown>>;
  expect(memories.some((item) => item.memory_id === previous.memory_id)).toBe(false);
  expect(memories.find((item) => item.text === '本人改为喜欢合成白茶。')).toMatchObject({
    level: 'owner', category: 'preference', adoption_method: 'manual', status: 'active', revision: 2,
    supersedes_memory_id: previous.memory_id, source_ids: previous.source_ids,
  });
}

// 下一片从公开表单补充资料，分别核对联系人范围与本人的共享范围。
export async function memoryManualAddition(manager: Page, fixture: MemoryFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const contact = manager.getByRole('region', { name: '联系人记忆', exact: true });
  await expect(contact.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  await contact.getByRole('button', { name: '补充联系人资料', exact: true }).click();
  const form = contact.getByRole('form', { name: '补充联系人资料', exact: true });
  await form.getByRole('textbox', { name: '资料正文', exact: true }).fill('甲手动补充的合成偏好。');
  await form.getByRole('combobox', { name: '资料分类', exact: true }).selectOption('preference');
  await form.getByRole('button', { name: '保存资料', exact: true }).click();
  const added = contact.getByRole('article').filter({ has: manager.getByText('甲手动补充的合成偏好。', { exact: true }) });
  await expect(added.getByText('手动采纳', { exact: true })).toBeVisible();
  const actual = await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact');
  expect(actual.status).toBe(200);
  expect((actual.data.memories as Array<Record<string, unknown>>).find((item) => item.text === '甲手动补充的合成偏好。'))
    .toMatchObject({ contact_id: fixture.data.contact_ids[0], category: 'preference', adoption_method: 'manual', status: 'active' });
  await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(fixture.data.contact_ids[1]);
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('甲手动补充的合成偏好。', { exact: true })).toHaveCount(0);
  const owner = manager.getByRole('region', { name: '本人记忆', exact: true });
  await owner.getByRole('button', { name: '补充本人资料', exact: true }).click();
  const ownForm = owner.getByRole('form', { name: '补充本人资料', exact: true });
  await ownForm.getByRole('textbox', { name: '资料正文', exact: true }).fill('本人手动补充的合成事实。');
  await ownForm.getByRole('button', { name: '保存资料', exact: true }).click();
  const ownAdded = owner.getByRole('article').filter({ has: manager.getByText('本人手动补充的合成事实。', { exact: true }) });
  await expect(ownAdded.getByText('手动采纳', { exact: true })).toBeVisible();
  const actualOwn = await fixture.readMemorySection(fixture.data.contact_ids[1], 'owner');
  expect(actualOwn.status).toBe(200);
  expect((actualOwn.data.memories as Array<Record<string, unknown>>).find((item) => item.text === '本人手动补充的合成事实。'))
    .toMatchObject({ level: 'owner', adoption_method: 'manual', status: 'active' });
  await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(fixture.data.contact_ids[0]);
  await expect(owner.getByText('本人手动补充的合成事实。', { exact: true })).toBeVisible();
}

export async function memoryContactCorrection(manager: Page, fixture: MemoryFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const contact = manager.getByRole('region', { name: '联系人记忆', exact: true });
  await expect(contact.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  const before = await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact');
  const previous = (before.data.memories as Array<Record<string, unknown>>).find((item) => item.text === '甲喜欢合成茉莉茶。')!;
  const other = await fixture.readMemorySection(fixture.data.contact_ids[1], 'contact');
  const own = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  await contact.getByRole('button', { name: '修正资料：甲喜欢合成茉莉茶。', exact: true }).click();
  const form = contact.getByRole('form', { name: '修正联系人资料', exact: true });
  await form.getByRole('textbox', { name: '资料正文', exact: true }).fill('甲改为喜欢合成白茶。');
  await form.getByRole('combobox', { name: '资料分类', exact: true }).selectOption('preference');
  await form.getByRole('button', { name: '保存修正', exact: true }).click();
  await expect(contact.getByText('甲改为喜欢合成白茶。', { exact: true })).toBeVisible();
  await expect(contact.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  const after = await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact');
  const corrected = (after.data.memories as Array<Record<string, unknown>>).find((item) => item.text === '甲改为喜欢合成白茶。')!;
  expect(corrected).toMatchObject({ level: 'contact', category: 'preference', adoption_method: 'manual', status: 'active',
    supersedes_memory_id: previous.memory_id, source_ids: previous.source_ids });
  expect(corrected.memory_id).not.toBe(previous.memory_id);
  expect(corrected.revision).toBe((previous.revision as number) + 1);
  expect((corrected.timing as Record<string, unknown>).source_started_at).toBe((previous.timing as Record<string, unknown>).source_started_at);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[1], 'contact')).toEqual(other);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner')).toEqual(own);
}

export async function memoryRemoval(manager: Page, fixture: MemoryFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const contact = manager.getByRole('region', { name: '联系人记忆', exact: true });
  const owner = manager.getByRole('region', { name: '本人记忆', exact: true });
  await expect(contact.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  const before = await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact');
  const ownBefore = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  const sources = await fixture.readMemorySection(fixture.data.contact_ids[0], 'sources');
  const pending = await fixture.readMemorySection(fixture.data.contact_ids[0], 'pending');
  const other = await fixture.readMemorySection(fixture.data.contact_ids[1], 'contact');
  const automatic = contact.getByRole('article').filter({ has: manager.getByText('甲喜欢合成茉莉茶。', { exact: true }) });
  await automatic.getByRole('button', { name: '撤销自动采纳：甲喜欢合成茉莉茶。', exact: true }).click();
  await expect(automatic.getByText('撤销等同删除这条资料，不删除来源消息，也不提供恢复承诺。', { exact: true })).toBeVisible();
  await automatic.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(contact.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  const manual = contact.getByRole('article').filter({ has: manager.getByText('甲的新版本关系备注。', { exact: true }) });
  await manual.getByRole('button', { name: '删除资料：甲的新版本关系备注。', exact: true }).click();
  await manual.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(contact.getByText('这位联系人暂无可查看记忆。', { exact: true })).toBeVisible();
  const ownManual = owner.getByRole('article').filter({ has: manager.getByText('本人喜欢合成绿茶。', { exact: true }) });
  await ownManual.getByRole('button', { name: '删除资料：本人喜欢合成绿茶。', exact: true }).click();
  await ownManual.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(owner.getByText('本人喜欢合成绿茶。', { exact: true })).toHaveCount(0);
  await expect(owner.getByText('本人手动录入的合成资料。', { exact: true })).toBeVisible();
  // 正文先撤下，权威提交以公开完成状态为准，不能用乐观隐藏代替。
  await expect(manager.getByText('资料操作已完成并重新核对。', { exact: true })).toBeVisible();
  const actual = await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact');
  const actualOwn = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  expect(actual.status).toBe(200);
  expect(actual.data.memories).toEqual([]);
  const deleted = (ownBefore.data.memories as Array<Record<string, unknown>>).find((item) => item.text === '本人喜欢合成绿茶。')!;
  expect((actualOwn.data.memories as Array<Record<string, unknown>>).some((item) => item.memory_id === deleted.memory_id)).toBe(false);
  expect(before.data.memories).toHaveLength(2);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'sources')).toEqual(sources);
  const currentPending = await fixture.readMemorySection(fixture.data.contact_ids[0], 'pending');
  expect(currentPending.status).toBe(200);
  const withoutReview = (items: Array<Record<string, unknown>>) => items.map(({ correction_review: _review, ...item }) => item);
  expect(withoutReview(currentPending.data.candidates as Array<Record<string, unknown>>))
    .toEqual(withoutReview(pending.data.candidates as Array<Record<string, unknown>>));
  const reviews = (currentPending.data.candidates as Array<Record<string, unknown>>)
    .flatMap((item) => item.correction_review as Array<Record<string, unknown>>);
  expect(reviews.length).toBeGreaterThan(0);
  for (const review of reviews) expect(review).toMatchObject({ decision: 'rejected', corrected_text: null,
    previous_text: '原资料已删除；旧证据上的人工否决继续有效。' });
  for (const erased of ['甲喜欢合成茉莉茶。', '甲的新版本关系备注。', '旧版关系备注。', '本人喜欢合成绿茶。']) {
    expect(JSON.stringify(currentPending.data)).not.toContain(erased);
  }
  expect(await fixture.readMemorySection(fixture.data.contact_ids[1], 'contact')).toEqual(other);
}

export async function memoryCandidateConfirmation(manager: Page, fixture: MemoryFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const pending = manager.getByRole('region', { name: '待确认候选', exact: true });
  await expect(pending.getByText('待确认 · 不是已确认事实', { exact: true })).toHaveCount(3);
  const before = await fixture.readMemorySection(fixture.data.contact_ids[0], 'pending');
  const other = await fixture.readMemorySection(fixture.data.contact_ids[1], 'contact');
  const sources = await fixture.readMemorySection(fixture.data.contact_ids[0], 'sources');
  for (const item of before.data.candidates as Array<Record<string, unknown>>) {
    await pending.getByRole('button', { name: `确认并保存：${item.text}`, exact: true }).click();
    await expect(pending.getByText(item.text as string, { exact: true })).toHaveCount(0);
    const region = manager.getByRole('region', { name: item.subject === 'self' ? '本人记忆' : '联系人记忆', exact: true });
    const card = region.getByRole('article').filter({ has: manager.getByText(item.text as string, { exact: true }) });
    await expect(card.getByText('手动采纳', { exact: true })).toBeVisible();
    const actual = await fixture.readMemorySection(fixture.data.contact_ids[0], item.subject === 'self' ? 'owner' : 'contact');
    expect(actual.status).toBe(200);
    // 既有联系人 DTO 未公开来源候选 ID；核对本轮唯一正文和直接来源，本人 DTO 另核候选链。
    const memory = (actual.data.memories as Array<Record<string, unknown>>).find((entry) =>
      item.subject === 'self' ? entry.source_candidate_id === item.candidate_id : entry.text === item.text)!;
    expect(memory).toMatchObject({ text: item.text, source_ids: item.source_ids, adoption_method: 'manual', status: 'active',
      level: item.subject === 'self' ? 'owner' : 'contact' });
  }
  await expect(pending.getByText('这位联系人暂无待确认候选。', { exact: true })).toBeVisible();
  expect((await fixture.readMemorySection(fixture.data.contact_ids[0], 'pending')).data.candidates).toEqual([]);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[1], 'contact')).toEqual(other);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'sources')).toEqual(sources);
}

export async function memoryCandidateDiscard(manager: Page, fixture: MemoryFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const pending = manager.getByRole('region', { name: '待确认候选', exact: true });
  await expect(pending.getByText('待确认 · 不是已确认事实', { exact: true })).toHaveCount(3);
  const before = await fixture.readMemorySection(fixture.data.contact_ids[0], 'pending');
  const contacts = await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact');
  const own = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  const sources = await fixture.readMemorySection(fixture.data.contact_ids[0], 'sources');
  const candidates = before.data.candidates as Array<Record<string, unknown>>;
  const item = candidates[0]!;
  await pending.getByRole('button', { name: `丢弃候选：${item.text}`, exact: true }).click();
  const card = pending.getByRole('article').filter({ has: manager.getByText(item.text as string, { exact: true }) });
  await card.getByRole('button', { name: '确认丢弃', exact: true }).click();
  // 三条候选实际使用相同旧证据；否决后不能靠主体或措辞变化留下另外两条。
  for (const previous of candidates) await expect(pending.getByText(previous.text as string, { exact: true })).toHaveCount(0);
  await expect(pending.getByText('这位联系人暂无待确认候选。', { exact: true })).toBeVisible();
  expect((await fixture.readMemorySection(fixture.data.contact_ids[0], 'pending')).data.candidates).toEqual([]);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact')).toEqual(contacts);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner')).toEqual(own);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'sources')).toEqual(sources);
}

export async function memoryMutationFailures(manager: Page, fixture: MemoryFixture, proxy: import('./memory-http-proxy').MemoryHttpProxy) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const owner = manager.getByRole('region', { name: '本人记忆', exact: true });
  await expect(owner.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  const before = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  const previous = (before.data.memories as Array<Record<string, unknown>>).find((item) => item.text === '本人喜欢合成绿茶。')!;
  const path = `/api/memories/owner/${previous.memory_id}/correct`;
  proxy.failurePaths.add(path);
  await owner.getByRole('button', { name: '修正资料：本人喜欢合成绿茶。', exact: true }).click();
  const form = owner.getByRole('form', { name: '修正本人资料', exact: true });
  await form.getByRole('textbox', { name: '资料正文', exact: true }).fill('本人失败后修正为合成红茶。');
  await form.getByRole('button', { name: '保存修正', exact: true }).click();
  await expect(manager.getByRole('alert').filter({ hasText: '未能完成资料操作与核对' })).toBeVisible();
  await expect(form.getByRole('textbox', { name: '资料正文', exact: true })).toHaveValue('本人失败后修正为合成红茶。');
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner')).toEqual(before);
  await expect(manager.getByText('资料操作已完成并重新核对。', { exact: true })).toHaveCount(0);
  proxy.failurePaths.delete(path);
  proxy.failurePaths.add('/api/memories/owner');
  await form.getByRole('button', { name: '保存修正', exact: true }).click();
  await expect(owner.getByText('本人记忆读取失败，请重试。', { exact: true })).toBeVisible();
  await expect(manager.getByRole('alert').filter({ hasText: '未能完成资料操作与核对' })).toBeVisible();
  await expect(manager.getByText('资料操作已完成并重新核对。', { exact: true })).toHaveCount(0);
  proxy.failurePaths.delete('/api/memories/owner');
  await owner.getByRole('button', { name: '重新读取本人记忆', exact: true }).click();
  const corrected = owner.getByRole('article').filter({ has: manager.getByText('本人失败后修正为合成红茶。', { exact: true }) });
  await expect(corrected.getByText('手动采纳', { exact: true })).toBeVisible();
  const after = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  expect((after.data.memories as Array<Record<string, unknown>>).find((item) => item.text === '本人失败后修正为合成红茶。'))
    .toMatchObject({ adoption_method: 'manual', supersedes_memory_id: previous.memory_id, source_ids: previous.source_ids });
}

// 公开具名能力拒绝越界参数和助手页写操作，真实传输边界没有写请求。
export async function memoryMutationArguments(manager: Page, helper: Page, fixture: MemoryFixture, proxy: import('./memory-http-proxy').MemoryHttpProxy) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  const snapshot = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  const pending = await fixture.readMemorySection(fixture.data.contact_ids[0], 'pending');
  const owner = (snapshot.data.memories as Array<Record<string, unknown>>)[0];
  const candidate = (pending.data.candidates as Array<Record<string, unknown>>)[0];
  const input = { contactId: fixture.data.contact_ids[0], memoryId: owner.memory_id as string,
    revision: owner.revision as number, candidateId: candidate.candidate_id as string, outside: fixture.data.other_contact_id };
  const before = proxy.requests.length;
  const rejected = await manager.evaluate(async (ids) => {
    const scope = await window.notalone.contacts.getState();
    const base = { contactId: ids.contactId, scopeRevision: scope.scopeRevision };
    const addition = { ...base, level: 'owner', text: '不应保存的合成资料。', category: 'common_fact' };
    const removal = { ...base, level: 'owner', memoryId: ids.memoryId, revision: ids.revision };
    const correction = { ...removal, text: addition.text, category: addition.category };
    const candidate = { ...base, candidateId: ids.candidateId };
    const calls = [
      ['add', { ...addition, ownerId: ids.outside }], ['add', { ...addition, contactId: ids.outside }],
      ['add', { ...addition, scopeRevision: scope.scopeRevision - 1 }], ['add', { ...addition, level: 'shared' }],
      ['correct', { ...correction, revision: 0 }], ['correct', { ...correction, url: '/api/anything' }],
      ['remove', { ...removal, revision: ids.revision + 1 }], ['remove', { ...removal, role: 'manager' }],
      ['confirmCandidate', { ...candidate, subject: 'self' }], ['discardCandidate', { ...candidate, candidateId: 'bad' }],
    ] as const;
    return Promise.all(calls.map(async ([name, request]) => {
      try { await (window.notalone.memory[name] as unknown as (value: unknown) => Promise<void>)(request); return false; }
      catch { return true; }
    }));
  }, input);
  expect(rejected).toEqual(Array(10).fill(true));
  const helperRejected = await helper.evaluate(async (ids) => {
    const scope = await window.notalone.contacts.getState();
    const base = { contactId: ids.contactId, scopeRevision: scope.scopeRevision };
    const addition = { ...base, level: 'owner', text: '助手不应保存的合成资料。', category: 'common_fact' };
    const removal = { ...base, level: 'owner', memoryId: ids.memoryId, revision: ids.revision };
    const requests = [['add', addition], ['correct', { ...removal, text: addition.text, category: addition.category }],
      ['remove', removal], ['confirmCandidate', { ...base, candidateId: ids.candidateId }],
      ['discardCandidate', { ...base, candidateId: ids.candidateId }]] as const;
    return Promise.all(requests.map(async ([name, request]) => {
      try { await (window.notalone.memory[name] as unknown as (value: unknown) => Promise<void>)(request); return false; }
      catch { return true; }
    }));
  }, input);
  expect(helperRejected).toEqual(Array(5).fill(true));
  expect(proxy.requests.slice(before).filter((item) => item.method === 'POST')).toEqual([]);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner')).toEqual(snapshot);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'pending')).toEqual(pending);
}

// 提交后的真实 GET 已完成但传输挂起；切换 scope 后不得发布旧操作结果。
export async function memoryMutationStale(manager: Page, fixture: MemoryFixture, proxy: import('./memory-http-proxy').MemoryHttpProxy, reconnect: boolean, failure: boolean) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const contact = manager.getByRole('region', { name: '联系人记忆', exact: true });
  await expect(contact.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  const before = await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact');
  const previous = (before.data.memories as Array<Record<string, unknown>>).find((item) => item.text === '甲喜欢合成茉莉茶。')!;
  const text = '甲经迟到提交保存的合成资料。';
  proxy.holdPath = `/api/contacts/${fixture.data.contact_ids[0]}/memories`;
  // 具名公开写操作返回 Promise，用于明确等待旧操作结束；不访问 React/控制器私有状态。
  const write = manager.evaluate(async ({ memoryId, revision, text }) => {
    const scope = await window.notalone.contacts.getState();
    await window.notalone.memory.correct({ contactId: scope.selectedContactId!, scopeRevision: scope.scopeRevision,
      level: 'contact', memoryId, revision, text, category: 'preference' });
  }, { memoryId: previous.memory_id as string, revision: previous.revision as number, text });
  await expect.poll(() => proxy.heldCount).toBe(1);
  proxy.holdPath = null;
  const saved = await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact');
  expect((saved.data.memories as Array<Record<string, unknown>>).find((item) => item.text === text))
    .toMatchObject({ supersedes_memory_id: previous.memory_id, adoption_method: 'manual' });
  if (reconnect) {
    proxy.failRuntimeStatus = true;
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    await expect(manager.getByRole('region', { name: '资料范围未确认' })).toBeVisible();
    proxy.failRuntimeStatus = false;
    proxy.holdPath = null;
    await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    await expect(manager.getByRole('combobox', { name: '资料联系人' })).toBeEnabled();
    await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(fixture.data.contact_ids[1]);
  } else {
    await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(fixture.data.contact_ids[1]);
  }
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  if (!reconnect) {
    proxy.holdPath = null;
    await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(fixture.data.contact_ids[0]);
    await expect(contact.getByText(text, { exact: true })).toBeVisible();
  }
  proxy.release(failure);
  await write;
  const state = await manager.evaluate(() => window.notalone.memory.getState());
  expect(state.mutation).toEqual({ phase: 'idle', message: '' });
  expect(state.contactId).toBe(fixture.data.contact_ids[reconnect ? 1 : 0]);
  await expect(manager.getByText('资料操作已完成并重新核对。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('未能完成资料操作与核对，请刷新确认后重试。', { exact: true })).toHaveCount(0);
  await expect(contact.getByText(reconnect ? '乙喜欢合成乌龙茶。' : text, { exact: true })).toBeVisible();
  if (reconnect) await expect(manager.getByText(text, { exact: true })).toHaveCount(0);
  expect(await fixture.readMemorySection(fixture.data.contact_ids[0], 'contact')).toEqual(saved);
}
