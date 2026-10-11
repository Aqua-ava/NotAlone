import { expect, type Browser, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';
import { PageHost } from './page-host';
import type { RewriteFixture } from '../rewrite-backend-fixture';
import { withEventPages } from './message-events';

interface CandidateGroup {
  candidate_id: string;
  text: string;
  messages: Array<{ message_id: string; text: string }>;
}
interface SavedGroupVersion {
  version_id: string;
  version_number: number;
  parent_version_id: string | null;
  requirements: string | null;
  messages: CandidateGroup['messages'];
}
async function history(fixture: RewriteFixture, contactId: string, sessionId: string, candidateId: string) {
  const saved = await fixture.request(`/api/contacts/${contactId}/assistant-sessions/${sessionId}/candidates/${candidateId}/versions`);
  expect(saved.status).toBe(200);
  return saved.data as { candidate_group_id: string; default_display_version_id: string;
    selected_version_id: string | null; versions: SavedGroupVersion[] };
}
async function selected(fixture: RewriteFixture, contactId: string, sessionId: string) {
  const saved = await fixture.request(`/api/contacts/${contactId}/assistant-sessions/${sessionId}/selections`);
  expect(saved.status).toBe(200);
  return saved.data.selection as { candidate_id: string; version_id: string } | null;
}
const groupOn = (page: Page, number: number) => page.getByRole('group', { name: `说法${number}消息组`, exact: true });

export async function replyStrategyMessageGroups(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊']) {
    process.stdout.write(`page_test_scenario: ${scene}整组编辑、明确版本选择、逐条复制与重建恢复\n`);
    const copied: string[] = [];
    let hidden = 0;
    const copySurface = { writeText: async (text: string) => { copied.push(text); }, hideWindow: () => { hidden++; } };
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }, host, userData) => {
      const contactId = rewriteBackend.data.contact_ids[0];
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, contactId);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') {
        await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
        await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('关心近况，不增加安排承诺。');
      } else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('关心近况，不增加安排承诺。');
      const groups = [['最近怎么样？', '方便时聊聊就好，不急着安排。'], ['想问问最近的近况。', '如果正在忙，之后再说也可以。']];
      await rewriteBackend.plan({ count: 2, message_groups: groups });
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect.poll(() => replyTransport.results.length).toBe(1);
      const generated = replyTransport.results[0];
      expect(generated.status).toBe(200);
      const candidates = generated.data.candidates as CandidateGroup[];
      expect(candidates).toHaveLength(2);
      expect(candidates.map((candidate) => candidate.messages.map((message) => message.text))).toEqual(groups);
      expect(new Set(candidates.flatMap((candidate) => candidate.messages.map((message) => message.message_id))).size).toBe(4);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
      const sessionId = generated.data.session_id as string;
      for (const [index, candidate] of candidates.entries()) {
        const saved = await history(rewriteBackend, contactId, sessionId, candidate.candidate_id);
        expect(saved.versions).toHaveLength(1);
        expect(saved.versions[0].messages).toEqual(candidate.messages);
        const group = groupOn(helper, index + 1);
        await expect(group.getByRole('textbox', { name: new RegExp(`^说法${index + 1}第[0-9]+条编辑文本$`) })).toHaveCount(2);
        for (const [number, message] of candidate.messages.entries()) {
          await expect(group.getByRole('textbox', { name: `说法${index + 1}第${number + 1}条编辑文本`, exact: true })).toHaveValue(message.text);
          await expect(group.getByRole('button', { name: `复制第${number + 1}条`, exact: true })).toBeDisabled();
        }
      }
      // 默认展示版本和旧单句候选的默认高亮都不能代替明确选择。
      expect(await selected(rewriteBackend, contactId, sessionId)).toBeNull();
      expect(copied).toEqual([]);
      expect(await helper.evaluate(async ({ candidateId, replyRequestId }) => {
        const state = await window.notalone.replies.getState();
        try { await window.notalone.candidateCopy.copy({ contactId: state.contactId!, scopeRevision: state.scopeRevision,
          candidateId, replyRequestId, hideAfterCopy: false }); return 'accepted'; }
        catch { return 'rejected'; }
      }, { candidateId: candidates[0].candidate_id, replyRequestId: generated.data.reply_request_id as string })).toBe('rejected');
      expect(copied).toEqual([]);
      const candidate = candidates[0], first = groupOn(helper, 1), second = groupOn(helper, 2);
      const edited = ['想问问最近过得怎么样。', candidate.messages[1].text];
      const requirement = '只放松措辞，不新增安排承诺。';
      await first.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true }).fill(edited[0]);
      await first.getByRole('textbox', { name: '说法1修改要求', exact: true }).fill(requirement);
      await expect(first.getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
      await expect(first.getByRole('radio', { name: '选择说法1当前版本', exact: true })).toBeDisabled();
      replyTransport.failNextCandidateVersionSave = true;
      await first.getByRole('button', { name: '保存本组修改', exact: true }).click();
      await expect(helper.getByRole('alert').filter({ hasText: '本组版本操作尚未确认' })).toBeVisible();
      await expect(first.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue(edited[0]);
      await expect(first.getByRole('textbox', { name: '说法1修改要求', exact: true })).toHaveValue(requirement);
      expect((await history(rewriteBackend, contactId, sessionId, candidate.candidate_id)).versions).toHaveLength(1);
      await helper.getByRole('button', { name: '重新读取本组版本', exact: true }).click();
      await expect(first.getByRole('button', { name: '保存本组修改', exact: true })).toBeEnabled();
      await expect(first.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue(edited[0]);
      await first.getByRole('button', { name: '保存本组修改', exact: true }).click();
      await expect(first.getByRole('combobox', { name: '说法1版本', exact: true }).getByRole('option')).toHaveCount(2);
      const saved = await history(rewriteBackend, contactId, sessionId, candidate.candidate_id);
      const initial = saved.versions[0], revision = saved.versions[1];
      expect(revision).toMatchObject({ version_number: 1, parent_version_id: initial.version_id, requirements: requirement });
      expect(revision.messages).toEqual(candidate.messages.map((message, index) => ({ ...message, text: edited[index] })));
      expect(saved.default_display_version_id).toBe(revision.version_id);
      expect(await selected(rewriteBackend, contactId, sessionId)).toBeNull();
      await expect(second.getByRole('textbox', { name: '说法2第1条编辑文本', exact: true })).toHaveValue(groups[1][0]);
      // 选择已真实提交而随后的 GET 失败；重读后选旧版必须使用该旧版自己的键。
      replyTransport.failNextCandidateSelectionRead = true;
      await first.getByRole('radio', { name: '选择说法1当前版本', exact: true }).click();
      await expect(helper.getByRole('alert').filter({ hasText: '当前版本尚未确认选择' })).toBeVisible();
      await expect(first.getByRole('radio', { name: '选择说法1当前版本', exact: true })).not.toBeChecked();
      await expect(first.getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
      expect((await selected(rewriteBackend, contactId, sessionId))?.version_id).toBe(revision.version_id);
      await helper.getByRole('button', { name: '重新读取本组版本', exact: true }).click();
      await first.getByRole('combobox', { name: '说法1版本', exact: true }).selectOption(initial.version_id);
      await first.getByRole('radio', { name: '选择说法1当前版本', exact: true }).click();
      await expect(first.getByRole('radio', { name: '选择说法1当前版本', exact: true })).toBeChecked();
      await expect(first.getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
      expect((await selected(rewriteBackend, contactId, sessionId))?.version_id).toBe(initial.version_id);
      await first.getByRole('combobox', { name: '说法1版本', exact: true }).selectOption(revision.version_id);
      await first.getByRole('radio', { name: '选择说法1当前版本', exact: true }).click();
      await expect(first.getByRole('radio', { name: '选择说法1当前版本', exact: true })).toBeChecked();
      await expect(first.getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
      expect(await selected(rewriteBackend, contactId, sessionId)).toMatchObject({ candidate_id: candidate.candidate_id, version_id: revision.version_id });
      for (let index = 0; index < edited.length; index++) {
        await first.getByRole('button', { name: `复制第${index + 1}条`, exact: true }).click();
        await expect(first.getByRole('status')).toContainText(`已复制第${index + 1}条，请自行粘贴并发送。`);
      }
      expect(copied).toEqual(edited);
      await expect(second.getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
      await first.getByRole('combobox', { name: '说法1版本', exact: true }).selectOption(initial.version_id);
      await expect(first.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue(groups[0][0]);
      await expect(first.getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
      expect((await selected(rewriteBackend, contactId, sessionId))?.version_id).toBe(revision.version_id);
      await first.getByRole('radio', { name: '选择说法1当前版本', exact: true }).click();
      await expect(first.getByRole('radio', { name: '选择说法1当前版本', exact: true })).toBeChecked();
      await expect(first.getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
      for (let index = 0; index < candidate.messages.length; index++) {
        await first.getByRole('button', { name: `复制第${index + 1}条`, exact: true }).click();
        await expect(first.getByRole('status')).toContainText(`已复制第${index + 1}条，请自行粘贴并发送。`);
      }
      expect(copied).toEqual([...edited, ...groups[0]]);
      await first.getByRole('combobox', { name: '说法1版本', exact: true }).selectOption(revision.version_id);
      await expect(first.getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
      expect((await selected(rewriteBackend, contactId, sessionId))?.version_id).toBe(initial.version_id);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);

      // 关闭旧宿主并重新装配真实 Main／HTTP，版本来自 PG；临时高亮不充当选择权威。
      await host.close();
      await rewriteBackend.command('restart');
      const restored = new PageHost(await browser.newContext(), origin, userData, { copySurface });
      try {
        await restored.backend.connect();
        const nextManager = await restored.open('manager');
        await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
        const nextHelper = await restored.open('helper');
        await confirmHelperContact(nextHelper, contactId);
        const recovered = groupOn(nextHelper, 1);
        await expect(recovered.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue(edited[0]);
        await expect(recovered.getByRole('combobox', { name: '说法1版本', exact: true })).toHaveValue(revision.version_id);
        await expect(recovered.getByRole('textbox', { name: '说法1修改要求', exact: true })).toHaveValue(requirement);
        await expect(recovered.getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
        expect((await selected(rewriteBackend, contactId, sessionId))?.version_id).toBe(initial.version_id);
        await recovered.getByRole('radio', { name: '选择说法1当前版本', exact: true }).click();
        await expect(recovered.getByRole('radio', { name: '选择说法1当前版本', exact: true })).toBeChecked();
        await expect(recovered.getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
        await recovered.getByRole('button', { name: '复制第1条', exact: true }).click();
        await expect(recovered.getByRole('status')).toContainText('已复制第1条，请自行粘贴并发送。');
        expect(copied).toEqual([...edited, ...groups[0], edited[0]]);
        expect((await history(rewriteBackend, contactId, sessionId, candidate.candidate_id)).versions).toEqual(saved.versions);
        expect(hidden).toBe(0);
      } finally { await restored.close(); }
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    }, copySurface);
    process.stdout.write(`page_test_scenario_passed: ${scene}整组编辑、明确版本选择、逐条复制与重建恢复\n`);
  }
  for (const scene of ['回应消息', '主动聊聊']) {
    const scenario = `${scene}真实新消息与${scene === '回应消息' ? '显式刷新' : '断流重连'}保留消息组编辑`;
    process.stdout.write(`page_test_scenario: ${scenario}\n`);
    await withEventPages(browser, origin, async ({ manager, helper, fixture }) => {
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, fixture.data.contact_ids[0]);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') {
        await helper.getByRole('radio', { name: /甲的原始合成消息/ }).click();
        await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('只关心近况，不承诺安排。');
      } else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('只关心近况，不承诺安排。');
      await fixture.plan({ count: 1, message_groups: [['最近过得怎么样？', '方便时再说就好。']] });
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      const group = groupOn(helper, 1);
      const editor = group.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true });
      await expect(editor).toHaveValue('最近过得怎么样？');
      await editor.fill('我想了解你最近的近况。');
      await group.getByRole('textbox', { name: '说法1修改要求', exact: true }).fill('只改变说法，不加承诺。');
      const before = await helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession!.currentInputVersionId);
      await fixture.command('append_burst');
      await expect(helper.getByRole('status').filter({ hasText: '当前联系人有新消息，生成依据仍是原快照' })).toBeVisible();
      await expect(editor).toHaveValue('我想了解你最近的近况。');
      if (scene === '回应消息') {
        await helper.getByRole('button', { name: '刷新消息', exact: true }).click();
        await expect(helper.getByRole('radio', { name: /甲的新合成消息/ }).first()).toBeVisible();
      } else {
        // 主动目的没有待回复消息列表，改走现有公开断流／重连，不伪造刷新目标。
        await expect(helper.getByRole('button', { name: '刷新消息', exact: true })).toHaveCount(0);
        await expect(helper.getByRole('group', { name: '待回复消息', exact: true })).toHaveCount(0);
        await fixture.command('disconnect_stream');
        await expect(helper.getByRole('status').filter({ hasText: '消息提醒已中断' })).toBeVisible();
        await fixture.command('append_message');
        await helper.getByRole('button', { name: '重连消息提醒', exact: true }).click();
        await expect(helper.getByRole('status').filter({ hasText: '消息提醒已恢复，期间可能有遗漏' })).toBeVisible();
      }
      await expect(editor).toHaveValue('我想了解你最近的近况。');
      await expect(group.getByRole('textbox', { name: '说法1修改要求', exact: true })).toHaveValue('只改变说法，不加承诺。');
      const after = await helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession!.currentInputVersionId);
      expect(after).toBe(before);
      expect((await fixture.command('observations')).model_calls).toBe(1);
    });
    process.stdout.write(`page_test_scenario_passed: ${scenario}\n`);
  }
}
