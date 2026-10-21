import { selectContact } from '../contact-picker-actions.mjs';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { fillWorkspaceThought, generateWorkspace } from '../workspace-actions';
import { withRewritePages } from './rewrite-acceptance';

interface SyntheticSkill { label: string; skill_id: string; version_id: string; name: string; version_number: number; marker: string; }

export async function replyStrategySkills(browser: Browser, origin: string) {
  for (const action of ['express', 'suggest'] as const) for (const match of [true, false]) {
    const name = `${action}${match ? '实际加载Skill并固定版本重试' : '无匹配时直接使用通用流程'}`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const [unused, selected, otherContact, otherOwner] = (await rewriteBackend.command('strategy_skills')).skills as SyntheticSkill[];
      await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
      await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
      await fillWorkspaceThought(helper, action === 'express' ? '想了解近况，但不增加安排承诺。' : '');
      if (match) await rewriteBackend.plan({ read_skill: selected.name });
      await rewriteBackend.plan({ count: 1, prefix: '自动策略候选' });
      replyTransport.nextReply = 'drop';
      await generateWorkspace(helper, action);
      await expect(helper.getByRole('alert').filter({ hasText: '未收到生成结果' })).toBeVisible();
      const request = replyTransport.requests.at(-1)!;
      expect(request).toMatchObject({ content: { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: action } });
      expect(request.skill_disabled ?? false).toBe(false);
      const original = replyTransport.results.at(-1)!;
      expect(original.status).toBe(200);
      if (match) expect(original.data.used_skill).toMatchObject({ version_id: selected.version_id, version_number: 2, load_state: 'loaded' });
      else expect(original.data.used_skill).toBeNull();
      const beforeRetry = await rewriteBackend.command('observations');
      expect(beforeRetry.payloads).toHaveLength(match ? 2 : 1);
      expect((beforeRetry.payloads as object[])[0]).toMatchObject({ input_mode: 'workspace', skill_selection: { mode: 'auto' } });
      const catalogue = JSON.stringify((beforeRetry.outbound_calls as unknown[][])[0]);
      expect(catalogue).toContain(unused.name);
      expect(catalogue).toContain(selected.name);
      expect(catalogue).not.toContain(unused.marker);
      expect(catalogue).not.toContain(selected.marker);
      await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: /^(候选1|说法1第1条)编辑文本$/ })).toHaveValue('自动策略候选（说法1）。');
      expect(replyTransport.requests.at(-1)).toEqual(request);
      expect(replyTransport.results.at(-1)).toEqual(original);
      expect(replyTransport.explorationRequests).toEqual([]);
      const afterRetry = await rewriteBackend.command('observations');
      expect(afterRetry.payloads, '响应丢失后重试不得重新调用模型或读取Skill').toEqual(beforeRetry.payloads);
      expect(afterRetry.skill_reads).toEqual(beforeRetry.skill_reads);
      const candidates = helper.getByRole('region', { name: '候选回复', exact: true });
      if (match) await expect(candidates).toContainText(`这组候选实际 Skill：${selected.name} · 版本 2`);
      else await expect(candidates).toContainText('这组候选使用通用流程。');
      const reads = (afterRetry.skill_reads as string[][]).at(-1)!;
      expect(reads).toEqual(match ? [expect.stringContaining(selected.marker)] : []);
      const outbound = JSON.stringify(afterRetry.outbound);
      for (const privateSkill of [otherContact, otherOwner]) {
        expect(outbound).not.toContain(privateSkill.name);
        expect(outbound).not.toContain(privateSkill.marker);
      }
      expect(outbound).not.toContain(unused.marker);
      if (match) expect(outbound).toContain(selected.marker);
      else expect(outbound).not.toContain(selected.marker);
    });
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
export async function replyStrategySkillInvalidation(browser: Browser, origin: string) {
  for (const workspaceAction of ['express', 'suggest'] as const) for (const action of ['disable', 'delete']) {
    const name = `${workspaceAction}实际Skill被${action}后新请求不得继续读取`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const first = ((await rewriteBackend.command('strategy_skills')).skills as SyntheticSkill[])[0];
      await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
      await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
      await fillWorkspaceThought(helper, workspaceAction === 'express' ? '只询问近况，不增加安排承诺。' : '');
      await rewriteBackend.plan({ read_skill: first.name });
      await rewriteBackend.plan({ count: 1, prefix: '失效前的实际策略候选' });
      await generateWorkspace(helper, workspaceAction);
      const editor = helper.getByRole('textbox', { name: /^(候选1|说法1第1条)编辑文本$/ });
      await expect(editor).toHaveValue('失效前的实际策略候选（说法1）。');
      expect(replyTransport.results.at(-1)!.data.used_skill).toMatchObject({ version_id: first.version_id, load_state: 'loaded' });
      const oldRequest = replyTransport.requests.at(-1)!;
      const changed = await rewriteBackend.request(`/api/skills/${first.skill_id}/${action}`, {});
      expect(changed.status).toBe(200);
      await rewriteBackend.plan({ count: 1, prefix: '失效Skill后通用候选' });
      await generateWorkspace(helper, workspaceAction);
      await expect(editor).toHaveValue('失效Skill后通用候选（说法1）。');
      expect(replyTransport.requests.at(-1)!.idempotency_key).not.toBe(oldRequest.idempotency_key);
      expect(replyTransport.results.at(-1)!.data.used_skill).toBeNull();
      expect(replyTransport.explorationRequests).toEqual([]);
      await expect(helper.getByRole('region', { name: '候选回复', exact: true })).toContainText('这组候选使用通用流程。');
      const observed = await rewriteBackend.command('observations');
      expect(observed.payloads).toHaveLength(3);
      expect((observed.skill_reads as string[][]).at(-1)).toEqual([]);
      const latest = JSON.stringify((observed.outbound_calls as unknown[][]).at(-1));
      expect(latest).not.toContain(first.marker);
      expect(latest).not.toContain(`/notalone/reply-skills/${first.name}/SKILL.md`);
      expect((observed.payloads as object[]).at(-1)).toMatchObject({ input_mode: 'workspace', skill_selection: { mode: 'auto' },
        fidelity_contract: { current_intent: workspaceAction === 'express' ? { text: '只询问近况，不增加安排承诺。' } : null } });
    });
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
