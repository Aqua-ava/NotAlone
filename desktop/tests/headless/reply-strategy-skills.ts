import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

interface SyntheticSkill { label: string; skill_id: string; version_id: string; name: string; version_number: number; marker: string; }

export async function replyStrategySkills(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊']) for (const match of [true, false]) {
    process.stdout.write(`page_test_scenario: ${scene}${match ? '自动匹配实际Skill并固定版本重试' : '无匹配时自动使用通用流程'}\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const [unused, selected, otherContact, otherOwner] = (await rewriteBackend.command('strategy_skills')).skills as SyntheticSkill[];
      const contactId = rewriteBackend.data.contact_ids[0];
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, contactId);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想了解近况，尚未决定本次意愿。');
      const strategy = helper.getByRole('region', { name: '理解与方向', exact: true });
      const actualStrategy = strategy.getByRole('status', { name: '本次使用的策略', exact: true });
      const candidates = helper.getByRole('region', { name: '候选回复', exact: true });
      await expect(actualStrategy).toContainText('将根据当前对话自动匹配');
      await expect(strategy.getByRole('combobox')).toHaveCount(0);
      await expect(strategy.getByRole('textbox', { name: '本次精确场景', exact: true })).toHaveCount(0);
      if (scene === '回应消息' && match) {
        // 模拟旧草稿和联系人缓存；新探索不能继承已经移除的手选或场景授权。
        await helper.evaluate(async () => {
          const state = await window.notalone.contacts.getState();
          const scope = { contactId: state.selectedContactId!, scopeRevision: state.scopeRevision };
          await window.notalone.replies.updateScene({ ...scope, scene: '旧草稿场景' });
          await window.notalone.replies.updateSkill({ ...scope, skill: { mode: 'disabled', versionId: null } });
        });
      }

      await rewriteBackend.plan({ select_skill: match ? selected.version_id : null });
      await rewriteBackend.plan({ explore: {} });
      replyTransport.nextExploration = 'drop';
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      await expect(strategy.getByRole('alert')).toContainText('方向建议暂不可用');
      expect(replyTransport.explorationRequests.at(-1)).toMatchObject({ content: { skill_mode: 'auto', skill_version_id: null } });
      expect((replyTransport.explorationRequests.at(-1)!.content as { skill_scene?: string | null }).skill_scene ?? null).toBeNull();
      const original = replyTransport.explorationResults.at(-1)!.data;
      if (match) expect(original.used_skill).toMatchObject({ version_id: selected.version_id, version_number: 2 });
      else expect(original.used_skill).toBeNull();
      const beforeRetry = await rewriteBackend.command('observations');
      await helper.getByRole('button', { name: '重试策略操作', exact: true }).click();
      await expect(actualStrategy).toContainText(match ? `实际 Skill：${selected.name} · 版本 2` : '本次使用通用流程。');
      const afterRetry = await rewriteBackend.command('observations');
      expect(afterRetry.payloads, '响应丢失后重试读取原探索，不应重新判断策略或生成方向').toEqual(beforeRetry.payloads);
      expect(replyTransport.explorationResults.at(-1)!.data.exploration_id).toBe(original.exploration_id);
      const selection = (afterRetry.payloads as Array<Record<string, unknown>>)
        .find(payload => payload.input_mode === 'exploration_skill_selection')!;
      expect((selection.skills as Array<{ version_id: string }>).map(item => item.version_id).sort())
        .toEqual([unused.version_id, selected.version_id].sort());
      expect(JSON.stringify(selection)).not.toContain(unused.marker);
      expect(JSON.stringify(selection)).not.toContain(selected.marker);
      expect(JSON.stringify(afterRetry.outbound)).not.toContain(otherContact.marker);
      expect(JSON.stringify(afterRetry.outbound)).not.toContain(otherOwner.marker);
      if (match) expect(JSON.stringify(afterRetry.outbound)).toContain(selected.marker);
      else expect(JSON.stringify(afterRetry.outbound)).not.toContain(selected.marker);
      expect(JSON.stringify(afterRetry.outbound)).not.toContain(unused.marker);

      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      await expect(strategy).toContainText('已确认本次意愿');
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      if (match) await rewriteBackend.plan({ read_skill: selected.name });
      await rewriteBackend.plan({ count: 1, prefix: '自动策略候选' });
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      try {
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('自动策略候选（说法1）。', { timeout: 15_000 });
      } catch (error) {
        const state = await helper.evaluate(() => window.notalone.replies.getState());
        const observed = await rewriteBackend.command('observations');
        process.stdout.write(`page_test_skill_generation_failure: ${JSON.stringify({ match, phase: state.phase, errorCode: state.errorCode,
          exploration: state.exploration.phase, replies: replyTransport.results.map(item => ({ status: item.status, error: item.data.error })),
          responses: replyTransport.explorationResults.map(item => ({ status: item.status, error: item.data.error, reason: item.data.reason,
            hasTurn: Boolean(item.data.turn) })), modelModes: (observed.payloads as Array<{ input_mode: string }>).map(item => item.input_mode),
          skillReads: observed.skill_reads })}\n`);
        throw error;
      }
      const generated = replyTransport.explorationResults.at(-1)!.data;
      expect((await helper.evaluate(() => window.notalone.replies.getState())).result!.input.scene ?? null).toBeNull();
      if (match) {
        expect((generated.turn as { used_skill: object }).used_skill).toMatchObject({ version_id: selected.version_id, load_state: 'loaded' });
        await expect(candidates).toContainText(`这组候选实际 Skill：${selected.name} · 版本 2`);
        await expect(actualStrategy).toContainText(`候选生成：实际 Skill：${selected.name} · 版本 2`);
      } else {
        expect((generated.turn as { used_skill: object | null }).used_skill).toBeNull();
        await expect(candidates.getByText('这组候选使用通用流程。', { exact: true })).toBeVisible();
      }
      const observed = await rewriteBackend.command('observations');
      const reads = (observed.skill_reads as string[][]).at(-1)!;
      if (match) expect(reads).toEqual([expect.stringContaining(selected.marker)]);
      else expect(reads).toEqual([]);
      expect(JSON.stringify(observed.outbound)).not.toContain(otherContact.marker);
      expect(JSON.stringify(observed.outbound)).not.toContain(otherOwner.marker);
    });
  }
}

export async function replyStrategySkillInvalidation(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊']) for (const action of ['disable', 'delete']) {
    process.stdout.write(`page_test_scenario: ${scene}自动选用后${action}实际Skill并拒绝旧问题\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const first = ((await rewriteBackend.command('strategy_skills')).skills as SyntheticSkill[])[0];
      const contactId = rewriteBackend.data.contact_ids[0];
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, contactId);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想了解近况，尚未决定本次意愿。');
      const strategy = helper.getByRole('region', { name: '理解与方向', exact: true });
      await rewriteBackend.plan({ select_skill: first.version_id });
      await rewriteBackend.plan({ explore: { question: { text: '本次是否不增加其他承诺？', impact: 'commitment' } } });
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      await expect(strategy).toContainText(`实际 Skill：${first.name} · 版本 1`);
      await expect(helper.getByRole('group', { name: '关键澄清', exact: true })).toBeVisible();
      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      await expect(strategy).toContainText('已确认本次意愿');
      const selected = replyTransport.explorationResults.at(-1)!.data;
      expect(selected.confirmed_intent).toBe('表示愿意等待，但不增加承诺。');
      const changed = await rewriteBackend.request(`/api/skills/${first.skill_id}/${action}`, {});
      expect(changed.status).toBe(200);
      expect((await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${selected.session_id}/explorations/${selected.exploration_id}`)).status).toBe(409);
      const beforeRejectedAnswer = await rewriteBackend.command('observations');
      await helper.getByRole('textbox', { name: '关键问题回答', exact: true }).fill('只保留刚才确认的本次意愿，不增加承诺。');
      await helper.getByRole('button', { name: '提交回答', exact: true }).click();
      await expect(strategy.getByRole('alert')).toContainText('方向建议暂不可用');
      expect(replyTransport.explorationResults.at(-1)!.status).toBe(409);
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      expect((await rewriteBackend.command('observations')).payloads).toEqual(beforeRejectedAnswer.payloads);

      await rewriteBackend.plan({ select_skill: null });
      await rewriteBackend.plan({ explore: {} });
      await helper.getByRole('button', { name: '更新理解', exact: true }).click();
      await expect(strategy.getByRole('status', { name: '本次使用的策略', exact: true })).toContainText('本次使用通用流程。');
      await expect(helper.getByRole('textbox', { name: '关键问题回答', exact: true })).toHaveCount(0);
      const refreshed = replyTransport.explorationResults.at(-1)!.data;
      expect(refreshed.used_skill).toBeNull();
      expect((refreshed.skill_choices as Array<{ version_id: string }>).map(item => item.version_id)).not.toContain(first.version_id);
      expect(refreshed.confirmed_intent).toBe('表示愿意等待，但不增加承诺。');
      await rewriteBackend.plan({ count: 1, prefix: '失效Skill后自动通用生成' });
      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      await expect(strategy).toContainText('已确认本次意愿');
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('失效Skill后自动通用生成（说法1）。', { timeout: 15_000 });
      expect((replyTransport.explorationResults.at(-1)!.data.turn as { used_skill: object | null }).used_skill).toBeNull();
      const observed = await rewriteBackend.command('observations');
      expect((observed.skill_reads as string[][]).at(-1)).toEqual([]);
      expect((observed.payloads as object[]).at(-1)).toMatchObject({ skill_selection: { mode: 'disabled' },
        fidelity_contract: { current_intent: { text: '表示愿意等待，但不增加承诺。' } } });
    });
  }
}
