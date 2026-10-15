import test from 'node:test';
import assert from 'node:assert/strict';
import { projectVisualAcceptance, visualAcceptanceAction, visualPreviewAction } from '../visual-acceptance-view.mjs';

const now = Date.parse('2026-10-15T04:00:00Z');
const confirmed = { phase: 'confirmed', observedAt: '2026-10-15T03:59:59Z', wechatInFront: true,
  probeAvailable: true, confirmation: 'verified-binding', confirmedContactId: 'contact-a',
  suspendedByHelperFocus: false, reason: null };
const project = foreground => projectVisualAcceptance({ foreground,
  selectedContactId: 'contact-a', expectedContactId: 'contact-a' }, now);

test('可视验收只在新鲜正式绑定同时匹配时显示成功，未知或旧观察不冒充通过', () => {
  assert.equal(project(confirmed).matched, true);
  const unknown = project({ ...confirmed, phase: 'unavailable', reason: 'foreground_application_unavailable' });
  assert.equal(unknown.classification, 'unknown');
  assert.equal(unknown.matched, false);
  assert.match(unknown.headline, /未知/);
  const old = project({ ...confirmed, observedAt: '2026-10-15T03:59:30Z' });
  assert.equal(old.classification, 'unknown');
  assert.equal(old.matched, false);
  const paused = project({ ...confirmed, suspendedByHelperFocus: true });
  assert.equal(paused.classification, 'other');
  assert.equal(paused.matched, false);
  assert.match(paused.headline, /助手.*暂停/);
  assert.ok(!JSON.stringify(project({ ...confirmed, reason: 'PRIVATE_NAME', title: 'PRIVATE_TITLE' })).includes('PRIVATE'));
});

test('窗口按钮只能驱动当前轮次和当前步骤，不能绕过前台检查或关闭状态', () => {
  const current = { runId: 'current-run', stage: 'baseline', state: 'waiting-trigger' };
  const click = { runId: 'current-run', stage: 'baseline', type: 'check' };
  assert.equal(visualAcceptanceAction(current, click), 'baseline.trigger');
  assert.equal(visualAcceptanceAction({ ...current, state: 'waiting-user' }, click), 'baseline-retry.trigger');
  assert.equal(visualAcceptanceAction({ ...current, state: 'measuring' }, click), null);
  assert.equal(visualAcceptanceAction(current, { ...click, runId: 'old-run' }), null);
  assert.equal(visualAcceptanceAction(current, { ...click, stage: 'resized' }), null);
  assert.equal(visualAcceptanceAction({ ...current, state: 'closing' }, { ...click, type: 'finish' }), null);
  assert.equal(visualAcceptanceAction({ ...current, stage: '../../private' }, { ...click, stage: '../../private' }), null);
  assert.equal(visualAcceptanceAction(current, { ...click, type: 'finish' }), 'finish.trigger');
});

test('失败留窗没有当前步骤时，仍可用本轮结束按钮退出且旧轮次无效', () => {
  const current = { runId: 'current-run', stage: null, state: 'failed-held' };
  const finish = { runId: 'current-run', stage: null, type: 'finish' };
  assert.equal(visualAcceptanceAction(current, finish), 'finish.trigger');
  assert.equal(visualAcceptanceAction(current, { ...finish, runId: 'old-run' }), null);
  assert.equal(visualAcceptanceAction(current, { ...finish, type: 'check' }), null);
});

test('名称识别失败显示固定环节和原因，不把失败投影的false当成微信非前台', () => {
  const failed = project({ ...confirmed, phase: 'unavailable', reason: 'session_name_confidence_low',
    probeAvailable: false, wechatInFront: false, confirmation: 'required', confirmedContactId: null });
  assert.deepEqual(failed.failure, { code: 'session_name_confidence_low', layer: '名称识别', message: '名称识别置信度不足' });
  assert.equal(failed.classification, 'unknown');
  assert.equal(failed.matched, false);
  assert.equal(project({ ...confirmed, phase: 'unavailable', reason: 'PRIVATE_RAW_ERROR' }).failure, null);
});

test('持续预览无需步骤推进，协调状态变化后仍可结束，旧轮次和关闭状态无效', () => {
  const current = { runId: 'current-run', stage: 'finish', state: 'waiting-trigger' };
  const finish = { runId: 'current-run', stage: null, type: 'finish' };
  assert.equal(visualPreviewAction(current, finish), 'finish');
  assert.equal(visualPreviewAction(current, { ...finish, type: 'open-helper' }), 'open-helper');
  assert.equal(visualPreviewAction(current, { ...finish, type: 'check' }), null);
  assert.equal(visualPreviewAction(current, { ...finish, runId: 'old-run' }), null);
  assert.equal(visualPreviewAction({ ...current, state: 'closing' }, finish), null);
});

test('离开微信只显示正常暂停，不累计识别失败；关闭同步不推断其他应用前台', () => {
  const paused = project({ ...confirmed, phase: 'paused', reason: 'wechat_not_in_front',
    wechatInFront: false, confirmation: 'required', confirmedContactId: null });
  assert.equal(paused.classification, 'other');
  assert.equal(paused.failure, null);
  assert.match(paused.detail, /定位暂停/);
  const disabled = project({ ...confirmed, phase: 'paused', reason: 'sync_disabled',
    wechatInFront: false, probeAvailable: false });
  assert.equal(disabled.classification, 'unknown');
  assert.equal(disabled.failure, null);
});

test('人工验收显示短时名称和联系人槽位，群聊暂停不展示标题且不冒充绑定通过', () => {
  const view = projectVisualAcceptance({ foreground: { ...confirmed, recognizedName: '合成私聊甲',
    recognitionConfidence: 0.96, generationBlock: null }, selectedContactId: 'contact-a',
    expectedContactId: 'contact-a', alternateContactId: 'contact-b', draftLength: 5 }, now);
  assert.equal(view.recognizedName, '合成私聊甲');
  assert.equal(view.confidencePercent, 96);
  assert.equal(view.selectedLabel, '测试联系人 A');
  assert.equal(view.generationAllowed, true);
  assert.equal(view.draftLength, 5);
  assert.equal(projectVisualAcceptance({ foreground: { ...confirmed, confirmedContactId: 'contact-b',
    generationBlock: null }, selectedContactId: 'contact-b', expectedContactId: 'contact-a',
    alternateContactId: 'contact-b' }, now).matched, true);
  const paused = project({ ...confirmed, phase: 'paused', reason: 'group_chat_suspected',
    unsupportedConversation: true, recognizedName: '不应展示的合成群 (8)', confirmation: 'required',
    confirmedContactId: null, generationBlock: 'foreground-confirmation-required' });
  assert.match(paused.headline, /群聊.*暂停/);
  assert.equal(paused.recognizedName, null);
  assert.equal(paused.generationAllowed, false);
  assert.equal(paused.matched, false);
  assert.equal(project({ ...confirmed, recognizedName: '已过期合成姓名',
    observedAt: '2026-10-15T03:59:30Z' }).recognizedName, null);
});

test('人工清单只接受本轮固定检查项和反馈结果，不能伪造结束或自动通过', () => {
  const current = { runId: 'current-run', stage: 'finish', state: 'waiting-trigger' };
  const feedback = { runId: 'current-run', stage: 'finish', type: 'checklist',
    checkId: 'draft-restore', outcome: 'matches' };
  assert.equal(visualPreviewAction(current, feedback), 'checklist');
  assert.equal(visualPreviewAction(current, { ...feedback, checkId: '../private' }), null);
  assert.equal(visualPreviewAction(current, { ...feedback, outcome: 'automatic-pass' }), null);
  assert.equal(visualPreviewAction(current, { ...feedback, runId: 'old-run' }), null);
  assert.equal(visualPreviewAction({ ...current, state: 'closing' }, feedback), null);
});
