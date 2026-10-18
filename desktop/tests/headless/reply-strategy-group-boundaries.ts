import { ensureReplySettingsOpen } from '../reply-settings-actions';
import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { RewritePages } from '../rewrite-page-scenarios';
import { withRewritePages } from './rewrite-acceptance';
import { PageHost } from './page-host';

type Scene = '回应消息' | '主动聊聊';
interface GroupIdentity {
  contactId: string;
  sessionId: string;
  replyRequestId: string;
  candidateId: string;
  messages: Array<{ message_id: string; text: string }>;
}
const groupOn = (page: Page) => page.getByRole('group', { name: '说法1消息组', exact: true });
const editorOn = (page: Page, number: number) => groupOn(page).getByRole('textbox', { name: `说法1第${number}条编辑文本`, exact: true });

async function prepare(pages: RewritePages, scene: Scene) {
  const contactId = pages.rewriteBackend.data.contact_ids[0];
  await pages.manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(pages.helper, contactId);
  await pages.helper.getByRole('button', { name: scene, exact: true }).click();
  if (scene === '回应消息') {
    await pages.helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
    await pages.helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('关心近况，不增加安排承诺。');
  } else await pages.helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('关心近况，不增加安排承诺。');
  await ensureReplySettingsOpen(pages.helper, '策略选择');
  await pages.helper.getByRole('combobox', { name: '策略选择', exact: true }).selectOption('disabled');
  return contactId;
}
async function generated(pages: RewritePages, contactId: string): Promise<GroupIdentity> {
  await pages.helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect.poll(() => pages.replyTransport.results.length).toBe(1);
  const result = pages.replyTransport.results[0];
  expect(result.status).toBe(200);
  const candidate = (result.data.candidates as Array<{ candidate_id: string; messages: GroupIdentity['messages'] }>)[0];
  await expect(editorOn(pages.helper, 1)).toHaveValue(candidate.messages[0].text);
  return { contactId, sessionId: result.data.session_id as string, replyRequestId: result.data.reply_request_id as string,
    candidateId: candidate.candidate_id, messages: candidate.messages };
}
async function actualHistory(pages: RewritePages, identity: GroupIdentity) {
  const result = await pages.rewriteBackend.request(`/api/contacts/${identity.contactId}/assistant-sessions/${identity.sessionId}/candidates/${identity.candidateId}/versions`);
  expect(result.status).toBe(200);
  return result.data as { default_display_version_id: string; selected_version_id: string | null;
    versions: Array<{ version_id: string; parent_version_id: string | null; requirements: string | null; messages: GroupIdentity['messages'] }> };
}
async function selectDisplayed(page: Page) {
  await groupOn(page).getByRole('radio', { name: '选择说法1当前版本', exact: true }).click();
  await expect(groupOn(page).getByRole('radio', { name: '选择说法1当前版本', exact: true })).toBeChecked();
  await expect(groupOn(page).getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
}
async function rejectCopy(page: Page, identity: GroupIdentity, versionId: string, messageId: string) {
  return page.evaluate(async ({ identity, versionId, messageId }) => {
    const state = await window.notalone.replies.getState();
    try {
      await window.notalone.candidateCopy.copy({ contactId: identity.contactId, scopeRevision: state.scopeRevision,
        replyRequestId: identity.replyRequestId, candidateId: identity.candidateId, versionId, messageId, hideAfterCopy: false });
      return 'accepted';
    } catch { return 'rejected'; }
  }, { identity, versionId, messageId });
}
function fullGroup(revision: number) {
  return Array.from({ length: 8 }, (_, index) => {
    const prefix = `合成版本${revision}第${index + 1}条：`;
    return prefix + '字'.repeat(8190 - prefix.length);
  });
}

async function longHistory(browser: Browser, origin: string, scene: Scene) {
  const copied: string[] = [];
  const copySurface = { writeText: async (text: string) => { copied.push(text); }, hideWindow: () => {} };
  await withRewritePages(browser, origin, async (pages, host, userData) => {
    const contactId = await prepare(pages, scene), original = fullGroup(0);
    await pages.rewriteBackend.plan({ count: 1, message_groups: [original] });
    const identity = await generated(pages, contactId);
    await expect(groupOn(pages.helper).getByRole('textbox', { name: /^说法1第[0-9]+条编辑文本$/ })).toHaveCount(8);
    let parent = identity.candidateId;
    for (let revision = 1; revision <= 3; revision++) {
      const texts = fullGroup(revision);
      for (let index = 0; index < texts.length; index++) {
        await editorOn(pages.helper, index + 1).fill(texts[index]);
        await editorOn(pages.helper, index + 1).blur();
        await expect(groupOn(pages.helper).getByRole('combobox', { name: '说法1版本', exact: true }).getByRole('option'))
          .toHaveCount((revision - 1) * texts.length + index + 2);
        const saved = await actualHistory(pages, identity), latest = saved.versions.at(-1)!;
        expect(latest.parent_version_id).toBe(parent);
        parent = latest.version_id;
      }
      const saved = await actualHistory(pages, identity), latest = saved.versions.at(-1)!;
      expect(latest.requirements).toBeNull();
      expect(latest.messages).toEqual(identity.messages.map((message, index) => ({ ...message, text: texts[index] })));
      expect(saved.selected_version_id).toBeNull();
      parent = latest.version_id;
    }
    const saved = await actualHistory(pages, identity);
    // 旧未分页的同一权威历史已超过原预算；生产公开控件仍必须完整读取全部版本。
    expect(Buffer.byteLength(JSON.stringify(saved), 'utf8')).toBeGreaterThan(1_048_576);
    await groupOn(pages.helper).getByRole('combobox', { name: '说法1版本', exact: true }).selectOption(identity.candidateId);
    for (let index = 0; index < original.length; index++) await expect(editorOn(pages.helper, index + 1)).toHaveValue(original[index]);
    await selectDisplayed(pages.helper);
    await groupOn(pages.helper).getByRole('button', { name: '复制第8条', exact: true }).click();
    await expect(groupOn(pages.helper).getByRole('status')).toContainText('已复制第8条，请自行粘贴并发送。');
    expect(copied).toEqual([original[7]]);
    expect((await pages.rewriteBackend.command('observations')).payloads).toHaveLength(1);
    await host.close();
    await pages.rewriteBackend.command('restart');
    const restored = new PageHost(await browser.newContext(), origin, userData, { copySurface });
    try {
      await restored.backend.connect();
      const manager = await restored.open('manager');
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      const helper = await restored.open('helper');
      await confirmHelperContact(helper, contactId);
      await expect(groupOn(helper).getByRole('combobox', { name: '说法1版本', exact: true }).getByRole('option')).toHaveCount(25);
      for (let index = 0; index < 8; index++) await expect(editorOn(helper, index + 1)).toHaveValue(fullGroup(3)[index]);
      await expect(groupOn(helper).getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
      await selectDisplayed(helper);
      await groupOn(helper).getByRole('button', { name: '复制第1条', exact: true }).click();
      await expect(groupOn(helper).getByRole('status')).toContainText('已复制第1条，请自行粘贴并发送。');
      expect(copied).toEqual([original[7], fullGroup(3)[0]]);
      expect((await pages.rewriteBackend.command('observations')).payloads).toHaveLength(1);
    } finally { await restored.close(); }
  }, copySurface);
}

async function deletedRestoredGroup(browser: Browser, origin: string, scene: Scene) {
  const copied: string[] = [];
  const copySurface = { writeText: async (text: string) => { copied.push(text); }, hideWindow: () => {} };
  await withRewritePages(browser, origin, async (pages, host, userData) => {
    const contactId = await prepare(pages, scene);
    await pages.rewriteBackend.plan({ count: 1, probe_history: true, cite_history: true,
      message_groups: [['合成来源支持的关心。', '方便时回复就好。']] });
    const identity = await generated(pages, contactId);
    await editorOn(pages.helper, 1).fill('已保存的来源派生组修改。');
    await editorOn(pages.helper, 1).blur();
    await expect(groupOn(pages.helper).getByRole('combobox', { name: '说法1版本', exact: true }).getByRole('option')).toHaveCount(2);
    const saved = await actualHistory(pages, identity), versionId = saved.versions[1].version_id;
    await host.close();
    await pages.rewriteBackend.command('restart');
    const restored = new PageHost(await browser.newContext(), origin, userData, { copySurface });
    try {
      await restored.backend.connect();
      const manager = await restored.open('manager');
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      const helper = await restored.open('helper');
      await confirmHelperContact(helper, contactId);
      await expect(editorOn(helper, 1)).toHaveValue('已保存的来源派生组修改。');
      await selectDisplayed(helper);
      await editorOn(helper, 1).fill('恢复后尚未保存的来源派生组编辑。');
      const sources = await pages.rewriteBackend.request(`/api/contacts/${contactId}/sources`);
      const sourceId = (sources.data.sources as Array<{ source_id: string }>)[0].source_id;
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '来源与过程');
      const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
        .filter({ hasText: `来源标识：${sourceId}` });
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(groupOn(helper)).toHaveCount(0);
      await expect(editorOn(helper, 1)).toHaveCount(0);
      expect(await rejectCopy(helper, identity, versionId, identity.messages[0].message_id)).toBe('rejected');
      expect(copied).toEqual([]);
      const unavailable = await pages.rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${identity.sessionId}/candidates/${identity.candidateId}/versions?page=0`);
      expect(unavailable.status).not.toBe(200);
      expect(unavailable.data).not.toHaveProperty('versions');
      const observations = await pages.rewriteBackend.command('observations');
      expect(observations.payloads).toHaveLength(2);
    } finally { await restored.close(); }
    await pages.rewriteBackend.command('restart');
    const reopened = new PageHost(await browser.newContext(), origin, userData, { copySurface });
    try {
      await reopened.backend.connect();
      const manager = await reopened.open('manager');
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      const helper = await reopened.open('helper');
      await confirmHelperContact(helper, contactId);
      await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true }).getByText('相关来源已删除', { exact: true })).toBeVisible();
      await expect(groupOn(helper)).toHaveCount(0);
      expect(await rejectCopy(helper, identity, versionId, identity.messages[0].message_id)).toBe('rejected');
      expect(copied).toEqual([]);
      expect((await pages.rewriteBackend.command('observations')).payloads).toHaveLength(2);
    } finally { await reopened.close(); }
  }, copySurface);
}

async function foreignIdentity(browser: Browser, origin: string) {
  const copied: string[] = [];
  const copySurface = { writeText: async (text: string) => { copied.push(text); }, hideWindow: () => {} };
  await withRewritePages(browser, origin, async (pages) => {
    const contactId = await prepare(pages, '主动聊聊');
    await pages.rewriteBackend.plan({ count: 2, message_groups: [['甲的第一组第1条。', '甲的第一组第2条。'], ['甲的第二组第1条。', '甲的第二组第2条。']] });
    const identity = await generated(pages, contactId);
    await selectDisplayed(pages.helper);
    const second = (pages.replyTransport.results[0].data.candidates as Array<{ candidate_id: string; messages: GroupIdentity['messages'] }>)[1];
    for (const [forged, versionId, messageId] of [
      [identity, randomUUID(), identity.messages[0].message_id],
      [identity, identity.candidateId, second.messages[0].message_id],
      [{ ...identity, candidateId: second.candidate_id }, identity.candidateId, identity.messages[0].message_id],
      [{ ...identity, replyRequestId: randomUUID() }, identity.candidateId, identity.messages[0].message_id],
    ] as const) expect(await rejectCopy(pages.helper, forged, versionId, messageId)).toBe('rejected');
    expect(copied).toEqual([]);
    await groupOn(pages.helper).getByRole('button', { name: '复制第1条', exact: true }).click();
    await expect(groupOn(pages.helper).getByRole('status')).toContainText('已复制第1条，请自行粘贴并发送。');
    expect(copied).toEqual([identity.messages[0].text]);
    const foreignContact = await pages.rewriteBackend.request(`/api/contacts/${pages.rewriteBackend.data.contact_ids[1]}/assistant-sessions/${identity.sessionId}/candidates/${identity.candidateId}/versions?page=0`);
    expect(foreignContact.status).toBe(404);
    expect(foreignContact.data).not.toHaveProperty('versions');
    const foreignOwner = await pages.rewriteBackend.command('read_group_as_other_owner', {
      session_id: identity.sessionId, candidate_id: identity.candidateId,
    });
    expect(foreignOwner.status).toBe(404);
    expect(foreignOwner.data).not.toHaveProperty('versions');
    await managerSwitch(pages);
    await expect(groupOn(pages.helper)).toHaveCount(0);
    expect(await rejectCopy(pages.helper, identity, identity.candidateId, identity.messages[0].message_id)).toBe('rejected');
    await pages.helper.getByRole('button', { name: '主动聊聊', exact: true }).click();
    await pages.helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('乙的新合成联系目的。');
    await pages.rewriteBackend.plan({ count: 1, message_groups: [['乙的新独立组第1条。', '乙的新独立组第2条。']] });
    await pages.helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(editorOn(pages.helper, 1)).toHaveValue('乙的新独立组第1条。');
    expect(await rejectCopy(pages.helper, { ...identity, contactId: pages.rewriteBackend.data.contact_ids[1] },
      identity.candidateId, identity.messages[0].message_id)).toBe('rejected');
    expect(copied).toEqual([identity.messages[0].text]);
    await expect(groupOn(pages.helper).getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
    expect((await pages.rewriteBackend.command('observations')).payloads).toHaveLength(2);
  }, copySurface);
}
async function managerSwitch(pages: RewritePages) {
  await pages.manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
  await confirmHelperContact(pages.helper, pages.rewriteBackend.data.contact_ids[1]);
}

export async function replyStrategyGroupBoundaries(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊'] as const) {
    for (const [name, run] of [
      [`${scene}完整八条组长历史、旧版明确复制及真实重建`, longHistory],
      [`${scene}来源删除清除恢复组和未保存编辑并拒绝重开复制`, deletedRestoredGroup],
    ] as const) {
      process.stdout.write(`page_test_scenario: ${name}\n`);
      await run(browser, origin, scene);
      process.stdout.write(`page_test_scenario_passed: ${name}\n`);
    }
  }
  process.stdout.write('page_test_scenario: 错版本、错组消息、跨联系人和跨用户身份拒绝\n');
  await foreignIdentity(browser, origin);
  process.stdout.write('page_test_scenario_passed: 错版本、错组消息、跨联系人和跨用户身份拒绝\n');
}
