import test from 'node:test';
import assert from 'node:assert/strict';
import { projectVisualAcceptance, visualAcceptanceAction } from '../visual-acceptance-view.mjs';

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
