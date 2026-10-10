import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

interface SyntheticSkill { label: string; skill_id: string; version_id: string; name: string; version_number: number; marker: string; }

export async function replyStrategySkills(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊']) {
    process.stdout.write(`page_test_scenario: ${scene}实际Skill版本延续、关闭与更换\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const skills = (await rewriteBackend.command('strategy_skills')).skills as SyntheticSkill[];
      const [first, second, otherContact, otherOwner] = skills;
      const contactId = rewriteBackend.data.contact_ids[0];
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, contactId);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想了解近况，尚未决定本次意愿。');
      await rewriteBackend.plan({ explore: {} });
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      const strategy = helper.getByRole('region', { name: '理解与方向', exact: true });
      const candidates = helper.getByRole('region', { name: '候选回复', exact: true });
      await expect(strategy).toContainText('本次使用通用流程。');
      const initial = replyTransport.explorationResults.at(-1)!.data;
      expect(initial.used_skill, '初次通用探索应没有实际Skill').toBeNull();
      expect((initial.skill_choices as Array<{ version_id: string }>).map((item) => item.version_id).sort())
        .toEqual([first.version_id, second.version_id].sort());
      const choice = helper.getByRole('combobox', { name: '策略选择', exact: true });
      await expect(choice.getByRole('option', { name: new RegExp(otherContact.name) })).toHaveCount(0);
      await expect(choice.getByRole('option', { name: new RegExp(otherOwner.name) })).toHaveCount(0);
      await choice.selectOption(first.version_id);
      await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toHaveCount(0);
      await rewriteBackend.plan({ explore: {} });
      await helper.getByRole('button', { name: '更新理解', exact: true }).click();
      await expect(strategy).toContainText(`实际 Skill：${first.name} · 版本 1`);
      const withFirst = replyTransport.explorationResults.at(-1)!.data;
      expect(withFirst.used_skill).toMatchObject({ version_id: first.version_id, version_number: 1 });
      const staticObserved = await rewriteBackend.command('observations');
      expect((staticObserved.outbound_calls as string[][]).at(-1)!.join('')).toContain(first.marker);
      expect((staticObserved.skill_reads as string[][]).at(-1)).toEqual([]);
      await rewriteBackend.plan({ read_skill: first.name });
      await rewriteBackend.plan({ count: 1, prefix: '固定第一实际版本' });
      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('固定第一实际版本（说法1）。');
      const firstGenerated = replyTransport.explorationResults.at(-1)!.data;
      expect((firstGenerated.turn as { used_skill: object }).used_skill).toMatchObject({ version_id: first.version_id, load_state: 'loaded' });
      let observed = await rewriteBackend.command('observations');
      expect(observed.payloads).toHaveLength(4);
      expect((observed.skill_reads as string[][]).at(-1)).toEqual([expect.stringContaining(first.marker)]);
      // 确认后的展示依据实际读取的回复元数据，不能仅显示下拉框中的偏好。
      await expect(candidates.getByText(`这组候选实际 Skill：${first.name} · 版本 1`, { exact: true })).toBeVisible();
      await rewriteBackend.plan({ read_skill: first.name });
      await rewriteBackend.plan({ count: 1, prefix: '普通生成沿用第一版本' });
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('普通生成沿用第一版本（说法1）。');
      expect(replyTransport.requests.at(-1)).toMatchObject({ skill_version_id: first.version_id });
      expect(replyTransport.results.at(-1)!.data.used_skill).toMatchObject({ version_id: first.version_id, load_state: 'loaded' });
      await expect(candidates.getByText(`这组候选实际 Skill：${first.name} · 版本 1`, { exact: true })).toBeVisible();

      await rewriteBackend.plan({ explore: {} });
      await helper.getByRole('button', { name: '更新理解', exact: true }).click();
      await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toBeVisible();
      const closingFirst = replyTransport.explorationResults.at(-1)!.data;
      await choice.selectOption('disabled');
      await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toHaveCount(0);
      await rewriteBackend.plan({ explore: {} });
      const disabledCount = replyTransport.explorationResults.length;
      await helper.getByRole('button', { name: '更新理解', exact: true }).click();
      await expect.poll(() => replyTransport.explorationResults.length).toBe(disabledCount + 1);
      expect(replyTransport.explorationResults.at(-1)!.status).toBe(200);
      await expect(strategy).toContainText('本次使用通用流程。');
      const disabled = replyTransport.explorationResults.at(-1)!.data;
      expect(disabled.used_skill, '明确关闭后当前探索应没有实际Skill').toBeNull();
      await rewriteBackend.plan({ count: 1, prefix: '关闭后通用确认' });
      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('关闭后通用确认（说法1）。');
      expect((replyTransport.explorationResults.at(-1)!.data.turn as { used_skill: object | null }).used_skill).toBeNull();
      await expect(candidates.getByText('这组候选使用通用流程。', { exact: true })).toBeVisible();
      await rewriteBackend.plan({ count: 1, prefix: '关闭后普通仍不自动选回' });
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('关闭后普通仍不自动选回（说法1）。');
      expect(replyTransport.requests.at(-1)).toMatchObject({ skill_disabled: true });
      expect(replyTransport.results.at(-1)!.data.used_skill).toBeNull();
      observed = await rewriteBackend.command('observations');
      expect(observed.payloads).toHaveLength(10);
      expect((observed.skill_reads as string[][]).at(-1)).toEqual([]);
      for (const messages of (observed.outbound_calls as string[][]).slice(7)) {
        expect(messages.join('')).not.toContain(first.marker);
        expect(messages.join('')).not.toContain(second.marker);
      }

      await choice.selectOption(second.version_id);
      await rewriteBackend.plan({ explore: {} });
      await helper.getByRole('button', { name: '更新理解', exact: true }).click();
      await expect(strategy).toContainText(`实际 Skill：${second.name} · 版本 2`);
      const secondExploration = replyTransport.explorationResults.at(-1)!.data;
      const oldSelection = (closingFirst.options as Array<{ suggestion_id: string }>)[0];
      const rejected = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${closingFirst.session_id}/explorations/${closingFirst.exploration_id}/confirm`, {
        input_version_id: closingFirst.input_version_id, suggestion_id: oldSelection.suggestion_id,
      });
      expect(rejected.status).toBe(409);
      await rewriteBackend.plan({ read_skill: second.name });
      await rewriteBackend.plan({ count: 1, prefix: '更换后只用第二实际版本' });
      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('更换后只用第二实际版本（说法1）。');
      const secondGenerated = replyTransport.explorationResults.at(-1)!.data;
      expect((secondGenerated.turn as { used_skill: object }).used_skill).toMatchObject({ version_id: second.version_id, load_state: 'loaded' });
      await expect(candidates.getByText(`这组候选实际 Skill：${second.name} · 版本 2`, { exact: true })).toBeVisible();
      observed = await rewriteBackend.command('observations');
      expect(observed.payloads).toHaveLength(13);
      const read = (observed.skill_reads as string[][]).at(-1)!;
      expect(read).toEqual([expect.stringContaining(second.marker)]);
      expect(read.join('')).not.toContain(first.marker);
      for (const messages of (observed.outbound_calls as string[][]).slice(10)) expect(messages.join('')).not.toContain(first.marker);
      expect(JSON.stringify(observed.outbound)).not.toContain(otherContact.marker);
      expect(JSON.stringify(observed.outbound)).not.toContain(otherOwner.marker);
      const saved = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${secondExploration.session_id}`);
      expect(saved.status).toBe(200);
      expect(JSON.stringify(saved.data)).toContain(second.version_id);
    });
  }
}

export async function replyStrategySkillInvalidation(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊']) for (const action of ['disable', 'delete']) {
    process.stdout.write(`page_test_scenario: ${scene}已确认意愿下${action}实际Skill并拒绝旧问题\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const first = ((await rewriteBackend.command('strategy_skills')).skills as SyntheticSkill[])[0];
      const contactId = rewriteBackend.data.contact_ids[0];
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, contactId);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想了解近况，尚未决定本次意愿。');
      await rewriteBackend.plan({ explore: {} });
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      const choice = helper.getByRole('combobox', { name: '策略选择', exact: true });
      await expect(choice.getByRole('option', { name: `${first.name} · 版本 1`, exact: true })).toHaveCount(1);
      await choice.selectOption(first.version_id);
      await rewriteBackend.plan({ explore: { question: { text: '本次是否不增加其他承诺？', impact: 'commitment' } } });
      await helper.getByRole('button', { name: '更新理解', exact: true }).click();
      await expect(helper.getByRole('group', { name: '关键澄清', exact: true })).toBeVisible();
      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      await expect(helper.getByRole('region', { name: '理解与方向', exact: true })).toContainText('已确认本次意愿');
      const selected = replyTransport.explorationResults.at(-1)!.data;
      expect(selected.confirmed_intent).toBe('表示愿意等待，但不增加承诺。');
      const changed = await rewriteBackend.request(`/api/skills/${first.skill_id}/${action}`, {});
      expect(changed.status).toBe(200);
      expect((await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${selected.session_id}/explorations/${selected.exploration_id}`)).status).toBe(409);
      await helper.getByRole('textbox', { name: '关键问题回答', exact: true }).fill('只保留刚才确认的本次意愿，不增加承诺。');
      await helper.getByRole('button', { name: '提交回答', exact: true }).click();
      await expect(helper.getByRole('region', { name: '理解与方向', exact: true }).getByRole('alert')).toContainText('方向建议暂不可用');
      expect(replyTransport.explorationResults.at(-1)!.status).toBe(409);
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
      await choice.selectOption('disabled');
      await rewriteBackend.plan({ explore: {} });
      await helper.getByRole('button', { name: '更新理解', exact: true }).click();
      const strategy = helper.getByRole('region', { name: '理解与方向', exact: true });
      await expect(strategy).toContainText('本次使用通用流程。');
      await expect(choice.getByRole('option', { name: `${first.name} · 版本 1`, exact: true })).toHaveCount(0);
      await expect(helper.getByRole('textbox', { name: '关键问题回答', exact: true })).toHaveCount(0);
      const refreshed = replyTransport.explorationResults.at(-1)!.data;
      expect(refreshed.used_skill).toBeNull();
      expect(refreshed.confirmed_intent).toBe('表示愿意等待，但不增加承诺。');
      await rewriteBackend.plan({ count: 1, prefix: '失效Skill后明确通用生成' });
      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('失效Skill后明确通用生成（说法1）。');
      expect((replyTransport.explorationResults.at(-1)!.data.turn as { used_skill: object | null }).used_skill).toBeNull();
      const observed = await rewriteBackend.command('observations');
      expect(observed.payloads).toHaveLength(4);
      expect((observed.skill_reads as string[][]).at(-1)).toEqual([]);
      for (const messages of (observed.outbound_calls as string[][]).slice(2)) expect(messages.join('')).not.toContain(first.marker);
      expect((observed.payloads as object[]).at(-1)).toMatchObject({ skill_selection: { mode: 'disabled' },
        fidelity_contract: { current_intent: { text: '表示愿意等待，但不增加承诺。' } } });
    });
  }
}
