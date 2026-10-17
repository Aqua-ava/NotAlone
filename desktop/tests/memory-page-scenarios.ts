import { expect, type Page } from '@playwright/test';
import type { MemoryFixture } from './memory-backend-fixture';
import type { MemoryHttpProxy } from './memory-http-proxy';
import type { MemorySectionName } from '../src/shared/memory-bridge';

export async function memoryDetails(manager: Page, memoryBackend: MemoryFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const contact = manager.getByRole('region', { name: '联系人记忆' });
  const owner = manager.getByRole('region', { name: '本人记忆' });
  const pending = manager.getByRole('region', { name: '待确认候选' });
  const automatic = contact.getByRole('article').filter({ has: manager.getByText('甲喜欢合成茉莉茶。', { exact: true }) });
  const corrected = contact.getByRole('article').filter({ has: manager.getByText('甲的新版本关系备注。', { exact: true }) });
  const expired = contact.getByRole('article').filter({ has: manager.getByText('甲已过期的合成状态。', { exact: true }) });
  const ownerCandidate = owner.getByRole('article').filter({ has: manager.getByText('本人喜欢合成绿茶。', { exact: true }) });
  const manualOwner = owner.getByRole('article').filter({ has: manager.getByText('本人手动录入的合成资料。', { exact: true }) });
  await expect(automatic.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  await expect(automatic.getByText('自动采纳（可撤销）', { exact: true })).toBeVisible();
  await expect(corrected.getByText('甲的新版本关系备注。', { exact: true })).toBeVisible();
  await expect(corrected.getByText('手动采纳', { exact: true })).toBeVisible();
  await expect(contact.getByText('旧版关系备注。', { exact: true })).toHaveCount(0);
  await expect(expired.getByText('甲已过期的合成状态。', { exact: true })).toBeVisible();
  await expect(expired.getByText('当前核实状态：历史资料（已过期）', { exact: true })).toBeVisible();
  await expect(contact.getByText('甲尚未生效的合成状态。', { exact: true })).toHaveCount(0);
  await expect(ownerCandidate.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  await expect(owner.getByText('另一用户的本人资料。', { exact: true })).toHaveCount(0);
  await expect(pending.getByText('待确认 · 不是已确认事实', { exact: true })).toHaveCount(3);
  await expect(pending.getByText('主体：本人', { exact: true })).toBeVisible();
  await expect(pending.getByText('主体：联系人', { exact: true })).toBeVisible();
  await expect(pending.getByText('主体：双方', { exact: true })).toBeVisible();
  await automatic.getByRole('button', { name: '查看来源与版本：甲喜欢合成茉莉茶。' }).click();
  await expect(automatic.getByText('来源聊天时间：2024年1月2日 10:00:00（UTC+8）', { exact: true })).toBeVisible();
  await expect(automatic.getByText('保存时间：2026年1月2日 10:00:00（UTC+8）', { exact: true })).toBeVisible();
  await expect(contact.getByText('保存时间：2024年1月2日 10:00:00（UTC+8）', { exact: true })).toHaveCount(0);
  await expect(automatic.getByText(`来源引用：${memoryBackend.data.direct_message_id}`, { exact: true })).toBeVisible();
  await expect(automatic.getByText('引用类型或来源详情暂不可用。', { exact: true })).toBeVisible();
  await corrected.getByRole('button', { name: '查看来源与版本：甲的新版本关系备注。' }).click();
  await expect(corrected.getByText(`替代版本引用：${memoryBackend.data.supersedes_memory_id}`, { exact: true })).toBeVisible();
  // 该修正来自主动录入，不能沿用无关聊天来源的日期或文件名。
  await expect(corrected.getByText(`当前联系人来源：${memoryBackend.data.manual_source_name} · 有效`, { exact: true })).toBeVisible();
  await expect(corrected.getByText('来源聊天时间：未知（来源时间不完整）', { exact: true })).toBeVisible();
  await ownerCandidate.getByRole('button', { name: '查看来源与版本：本人喜欢合成绿茶。' }).click();
  await expect(ownerCandidate.getByText(`来源候选引用：${memoryBackend.data.owner_candidate_id}`, { exact: true })).toBeVisible();
  await manualOwner.getByRole('button', { name: '查看来源与版本：本人手动录入的合成资料。' }).click();
  await expect(manualOwner.getByText('来源聊天时间：未知（来源时间不完整）', { exact: true })).toBeVisible();
  await expect(pending.getByText(/来源时间不完整/)).toHaveCount(3);
  const sources = manager.getByRole('region', { name: '当前联系人来源' });
  await expect(sources.getByText(`来源标识：${memoryBackend.data.source_document_id}`, { exact: true })).toBeVisible();
  await expect(sources.getByText('2 条记录 · 有效', { exact: true })).toBeVisible();
  await memoryHttpIsolation(memoryBackend);
}

export async function memoryScopeAndEmpty(manager: Page, memoryBackend: MemoryFixture) {
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByRole('region', { name: '资料范围未确认' })).toBeVisible();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[0]);
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[1]);
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.empty_contact_id);
  await expect(manager.getByText('这位联系人暂无可查看记忆。', { exact: true })).toBeVisible();
  await expect(manager.getByText('这位联系人暂无待确认候选。', { exact: true })).toBeVisible();
  await expect(manager.getByText('这位联系人暂无来源记录。', { exact: true })).toBeVisible();
  await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  await expect(manager.getByRole('alert')).toHaveCount(0);
}

export async function memoryNamedArguments(manager: Page, memoryBackend: MemoryFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const rejected = await manager.evaluate(async (outsideContactId) => {
    const current = await window.notalone.contacts.getState();
    const invalid = [
      { contactId: outsideContactId, scopeRevision: current.scopeRevision },
      { contactId: current.selectedContactId!, scopeRevision: current.scopeRevision - 1 },
      { contactId: current.selectedContactId!, scopeRevision: current.scopeRevision, ownerId: outsideContactId },
      { contactId: current.selectedContactId!, scopeRevision: current.scopeRevision, section: 'http' },
      { contactId: current.selectedContactId!, scopeRevision: current.scopeRevision, role: 'manager' },
      { contactId: current.selectedContactId!, scopeRevision: current.scopeRevision, url: 'http://127.0.0.1:1' },
    ];
    return Promise.all(invalid.map(async (request) => {
      try { await window.notalone.memory.refresh(request as Parameters<typeof window.notalone.memory.refresh>[0]); return false; }
      catch { return true; }
    }));
  }, memoryBackend.data.other_contact_id);
  expect(rejected).toEqual([true, true, true, true, true, true]);
  expect(await manager.evaluate(() => Object.keys(window.notalone.memory).sort())).toEqual(['add', 'confirmCandidate', 'correct', 'discardCandidate', 'getState', 'onStateChanged', 'refresh', 'remove']);
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('另一用户的联系人资料。', { exact: true })).toHaveCount(0);
  expect(await manager.evaluate(async () => {
    window.location.hash = '#helper';
    try { await window.notalone.memory.getState(); return false; }
    catch { return true; } finally { window.location.hash = '#manager'; }
  })).toBe(true);
}

async function memoryHttpIsolation(fixture: MemoryFixture) {
  const a = fixture.data.contact_ids[0];
  const memories = await fixture.readMemorySection(a, 'contact');
  expect(memories.status).toBe(200);
  expect((memories.data.memories as Array<{ text: string }>).map((item) => item.text).sort()).toEqual(['甲喜欢合成茉莉茶。', '甲的新版本关系备注。', '甲已过期的合成状态。'].sort());
  const owners = await fixture.readMemorySection(a, 'owner');
  expect(owners.status).toBe(200);
  expect((owners.data.memories as Array<{ text: string }>).map((item) => item.text).sort()).toEqual(['本人喜欢合成绿茶。', '本人手动录入的合成资料。'].sort());
  const pending = await fixture.readMemorySection(a, 'pending');
  expect(pending.status).toBe(200);
  expect((pending.data.candidates as Array<{ subject: string }>).map((item) => item.subject).sort()).toEqual(['contact', 'self', 'shared']);
  const sources = await fixture.readMemorySection(a, 'sources');
  expect(sources.status).toBe(200);
  expect((sources.data.sources as Array<{ source_id: string }>).map((item) => item.source_id).sort())
    .toEqual([fixture.data.source_document_id, fixture.data.manual_source_id].sort());
  for (const section of ['contact', 'pending', 'sources'] as const) {
    const outside = await fixture.readMemorySection(fixture.data.other_contact_id, section);
    expect(outside.status).toBe(200);
    expect(outside.data[section === 'contact' ? 'memories' : section === 'pending' ? 'candidates' : 'sources']).toEqual([]);
  }
}

const sections = {
  contact: { title: '联系人记忆', text: '甲喜欢合成茉莉茶。', empty: '这位联系人暂无可查看记忆。', suffix: 'memories' },
  owner: { title: '本人记忆', text: '本人喜欢合成绿茶。', empty: '当前本人暂无可查看记忆。', suffix: '' },
  pending: { title: '待确认候选', text: '甲可能参加合成旅行计划。', empty: '这位联系人暂无待确认候选。', suffix: 'memory-candidates' },
  sources: { title: '当前联系人来源', text: 'synthetic.jsonl', empty: '这位联系人暂无来源记录。', suffix: 'sources' },
};

// 每栏通过真实传输挂起、失败、重读；仅记录方法/路径，不记录认证或正文。
export async function memorySectionFailure(manager: Page, fixture: MemoryFixture, proxy: MemoryHttpProxy, section: MemorySectionName) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  for (const value of Object.values(sections)) await expect(manager.getByRole('region', { name: value.title }).getByText(value.text, { exact: true })).toBeVisible();
  const path = section === 'owner' ? '/api/memories/owner' : `/api/contacts/${fixture.data.contact_ids[0]}/${sections[section].suffix}`;
  proxy.holdPath = path;
  const refresh = manager.evaluate(async (selectedSection) => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.memory.refresh({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, section: selectedSection });
  }, section);
  await expect.poll(() => proxy.heldCount).toBe(1);
  const selected = manager.getByRole('region', { name: sections[section].title });
  await expect(selected.getByText(`正在读取${sections[section].title}…`, { exact: true })).toBeVisible();
  for (const [key, value] of Object.entries(sections)) if (key !== section) {
    await expect(manager.getByRole('region', { name: value.title }).getByText(value.text, { exact: true })).toBeVisible();
  }
  proxy.release(true);
  await refresh;
  await expect(selected.getByRole('alert')).toHaveText(`${sections[section].title}读取失败，请重试。`);
  await expect(selected.getByText(sections[section].empty, { exact: true })).toHaveCount(0);
  const before = proxy.requests.length;
  proxy.holdPath = null;
  await selected.getByRole('button', { name: `重新读取${sections[section].title}`, exact: true }).click();
  await expect(selected.getByText(sections[section].text, { exact: true })).toBeVisible();
  expect(proxy.requests.slice(before).filter((request) => request.method === 'GET' && (request.path.includes('/memories') || request.path.endsWith('/memory-candidates') || request.path.endsWith('/sources')))).toEqual([{ method: 'GET', path }]);
  for (const [key, value] of Object.entries(sections)) if (key !== section) {
    await expect(manager.getByRole('region', { name: value.title }).getByText(value.text, { exact: true })).toBeVisible();
  }
  await expect(manager.getByRole('alert')).toHaveCount(0);
}

export async function memoryAllEmpty(manager: Page, fixture: MemoryFixture) {
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(fixture.data.empty_contact_id);
  for (const [key, value] of Object.entries(sections)) {
    await expect(manager.getByRole('region', { name: value.title }).getByText(value.empty, { exact: true })).toBeVisible();
    const result = await fixture.readMemorySection(fixture.data.empty_contact_id, key as MemorySectionName);
    expect(result.status).toBe(200);
    expect(result.data[key === 'pending' ? 'candidates' : key === 'sources' ? 'sources' : 'memories']).toEqual([]);
  }
  await expect(manager.getByRole('alert')).toHaveCount(0);
}

export async function memoryNewestRefresh(manager: Page, memoryBackend: MemoryFixture, memoryProxy: MemoryHttpProxy, failure: boolean) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  memoryProxy.holdPath = `/api/contacts/${memoryBackend.data.contact_ids[0]}/memories`;
  const refresh = manager.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.memory.refresh({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, section: 'contact' });
  });
  await expect.poll(() => memoryProxy.heldCount).toBe(1);
  await memoryBackend.addSyntheticContactMemory(memoryBackend.data.contact_ids[0], '同一范围最新读取的合成资料。');
  memoryProxy.holdPath = null;
  await manager.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.memory.refresh({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, section: 'contact' });
  });
  await expect(manager.getByText('同一范围最新读取的合成资料。', { exact: true })).toBeVisible();
  memoryProxy.release(failure);
  await refresh;
  await expect(manager.getByText('同一范围最新读取的合成资料。', { exact: true })).toBeVisible();
  await expect(manager.getByText('联系人记忆读取失败，请重试。', { exact: true })).toHaveCount(0);
}

export async function memoryScopeRoundTrip(manager: Page, memoryBackend: MemoryFixture, memoryProxy: MemoryHttpProxy, failure: boolean) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  memoryProxy.holdPath = `/api/contacts/${memoryBackend.data.contact_ids[0]}/memories`;
  const refresh = manager.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.memory.refresh({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, section: 'contact' });
  });
  await expect.poll(() => memoryProxy.heldCount).toBe(1);
  await expect(manager.getByText('正在读取联系人记忆…', { exact: true })).toBeVisible();
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[1]);
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  await memoryBackend.addSyntheticContactMemory(memoryBackend.data.contact_ids[0], '甲在切换后新增的合成资料。');
  memoryProxy.holdPath = null;
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[0]);
  await expect(manager.getByText('甲在切换后新增的合成资料。', { exact: true })).toBeVisible();
  memoryProxy.release(failure);
  await refresh;
  await expect(manager.getByText('甲在切换后新增的合成资料。', { exact: true })).toBeVisible();
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('联系人记忆读取失败，请重试。', { exact: true })).toHaveCount(0);
}

export async function memoryReconnect(manager: Page, memoryBackend: MemoryFixture, memoryProxy: MemoryHttpProxy, failure: boolean) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  memoryProxy.holdPath = `/api/contacts/${memoryBackend.data.contact_ids[0]}/memories`;
  const refresh = manager.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.memory.refresh({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, section: 'contact' });
  });
  await expect.poll(() => memoryProxy.heldCount).toBe(1);
  memoryProxy.failRuntimeStatus = true;
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  await expect(manager.getByRole('region', { name: '资料范围未确认' })).toBeVisible();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  memoryProxy.failRuntimeStatus = false;
  memoryProxy.holdPath = null;
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(manager.getByRole('combobox', { name: '资料联系人' })).toBeEnabled();
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[1]);
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  memoryProxy.release(failure);
  await refresh;
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('联系人记忆读取失败，请重试。', { exact: true })).toHaveCount(0);
}

export async function memoryIndependentFailures(manager: Page, memoryBackend: MemoryFixture, memoryProxy: MemoryHttpProxy) {
  memoryProxy.failurePaths.add('/api/memories/owner');
  memoryProxy.failurePaths.add(`/api/contacts/${memoryBackend.data.contact_ids[0]}/sources`);
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('本人记忆读取失败，请重试。', { exact: true })).toBeVisible();
  await expect(manager.getByText('当前联系人来源读取失败，请重试。', { exact: true })).toBeVisible();
  await expect(manager.getByText('当前本人暂无可查看记忆。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('这位联系人暂无来源记录。', { exact: true })).toHaveCount(0);
  await manager.getByRole('button', { name: '查看来源与版本：甲喜欢合成茉莉茶。' }).click();
  const automatic = manager.getByRole('region', { name: '联系人记忆', exact: true }).getByRole('article')
    .filter({ has: manager.getByText('甲喜欢合成茉莉茶。', { exact: true }) });
  await expect(automatic.getByText('来源目录读取失败，暂时无法核对这项引用。', { exact: true })).toBeVisible();
  memoryProxy.failurePaths.clear();
  await manager.getByRole('button', { name: '重新读取本人记忆', exact: true }).click();
  await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('当前联系人来源读取失败，请重试。', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '重新读取当前联系人来源', exact: true }).click();
  await expect(manager.getByRole('region', { name: '当前联系人来源' }).getByText('synthetic.jsonl', { exact: true })).toBeVisible();
  const deletion = manager.getByRole('region', { name: '来源删除管理', exact: true });
  await deletion.getByRole('button', { name: '刷新删除状态', exact: true }).click();
  const source = deletion.getByRole('listitem').filter({ hasText: 'synthetic.jsonl' });
  await expect(source.getByText('synthetic.jsonl', { exact: true })).toBeVisible();
  await expect(source.getByRole('status')).toHaveText('有效来源');
  await expect(manager.getByRole('alert')).toHaveCount(0);
}
