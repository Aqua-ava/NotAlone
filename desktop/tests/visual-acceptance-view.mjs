import { foregroundFailureReason } from '../src/shared/foreground-failure.mjs';

const stages = new Set(['baseline', 'moved', 'resized', 'switch-b', 'return-a', 'other-app', 'helper-pause', 'resume-a', 'finish']);
export const visualChecklist = Object.freeze([
  ['name', '私聊名称与绑定正确'], ['move', '移动微信后恢复'], ['resize', '缩放微信后恢复'],
  ['group-pause', '群聊暂停匹配和新生成'], ['private-resume', '回到私聊恢复'],
  ['helper-pause', '进入助手后暂停采集'], ['wechat-resume', '回微信后恢复识别'],
  ['contact-switch', 'A / B 联系人切换正确'], ['draft-restore', '切回后草稿保留'],
  ['result-scope', '候选结果属于原联系人'],
]);

// 名称仅供本机窗口短时展示；计数报告不保存此投影或原始ID、草稿正文。
export function projectVisualAcceptance({ foreground: state, selectedContactId, expectedContactId,
  alternateContactId, draftLength = 0 }, now = Date.now()) {
  const observed = Date.parse(state.observedAt ?? '');
  const age = Number.isFinite(observed) ? now - observed : NaN;
  const fresh = age >= 0 && age <= 5000;
  const failure = state.phase === 'unavailable' || state.phase === 'manual-required'
    ? foregroundFailureReason(state.reason) : null;
  let headline = '等待新的正式观察';
  let classification = 'unknown';
  if (state.suspendedByHelperFocus) {
    headline = '助手获焦，定位暂停';
    classification = 'other';
  } else if (state.reason === 'foreground_application_unavailable') headline = '系统前台状态未知';
  else if (state.reason === 'probe_timeout' || state.reason === 'observation_timeout') headline = '正式观察超时';
  else if (state.phase === 'unavailable') headline = '正式观察暂不可用';
  else if (fresh && state.wechatInFront === true) {
    headline = '正式 App 报告：微信在前台';
    classification = 'wechat';
  } else if (fresh && state.wechatInFront === false && state.phase === 'paused'
    && state.reason === 'wechat_not_in_front' && state.probeAvailable === true) {
    headline = '正式 App 报告：微信非前台';
    classification = 'other';
  }
  if (state.unsupportedConversation) headline = '群聊暂不支持，前台匹配与新生成暂停';
  const contactLabel = id => id && id === expectedContactId ? '测试联系人 A'
    : id && id === alternateContactId ? '测试联系人 B' : id ? '范围外联系人' : '未选择';
  const matched = classification === 'wechat' && state.confirmation === 'verified-binding'
    && !state.unsupportedConversation && Boolean(expectedContactId)
    && [expectedContactId, alternateContactId].filter(Boolean).includes(state.confirmedContactId)
    && selectedContactId === state.confirmedContactId;
  const showName = fresh && classification === 'wechat' && !state.unsupportedConversation
    && ['confirmed', 'manual-required'].includes(state.phase) && typeof state.recognizedName === 'string';
  return { headline, classification, matched, failure,
    recognizedName: showName ? state.recognizedName : null,
    confidencePercent: showName && Number.isFinite(state.recognitionConfidence) ? Math.round(state.recognitionConfidence * 100) : null,
    selectedLabel: contactLabel(selectedContactId),
    confirmedLabel: state.confirmation === 'required' ? '未确认' : contactLabel(state.confirmedContactId),
    generationAllowed: !state.unsupportedConversation && state.generationBlock === null,
    draftLength: Number.isInteger(draftLength) && draftLength >= 0 && draftLength <= 65536 ? draftLength : 0,
    ageSeconds: Number.isFinite(age) && age >= 0 ? Math.round(age / 1000) : null,
    detail: state.unsupportedConversation ? '保留原私聊内容；已授权私聊后台同步继续。回私聊后重新核验。'
      : matched ? '已通过正式绑定匹配测试联系人' : state.suspendedByHelperFocus ? '进入助手时暂停新观察，保留联系人内容'
      : classification === 'other' && state.phase === 'paused' ? '微信离开前台，定位暂停；返回微信后自动恢复'
      : state.phase === 'manual-required' ? '名称或绑定未通过，保留人工确认门' : '尚未取得新鲜的正式绑定匹配' };
}

export function visualAcceptanceAction(current, event) {
  if (!current || current.state === 'closing' || !current.runId
    || event?.runId !== current.runId || event.stage !== current.stage) return null;
  if (event.type === 'finish') return 'finish.trigger';
  if (event.type !== 'check' || !stages.has(current.stage)) return null;
  if (current.state === 'waiting-trigger') return `${current.stage}.trigger`;
  if (current.state === 'waiting-user' && !['finish', 'other-app'].includes(current.stage)) return `${current.stage}-retry.trigger`;
  return null;
}

// 持续预览不推进验收步骤；动作只属于当前存活场次，结束仍走协调器的租约检查。
export function visualPreviewAction(current, event) {
  if (!current?.runId || current.state === 'closing' || event?.runId !== current.runId) return null;
  if (event.type === 'checklist') return visualChecklist.some(([id]) => id === event.checkId)
    && ['matches', 'mismatches', 'unverified'].includes(event.outcome) ? 'checklist' : null;
  return ['wechat', 'other', 'open-helper', 'finish'].includes(event.type) ? event.type : null;
}
