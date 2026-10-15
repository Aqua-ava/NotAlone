const stages = new Set(['baseline', 'moved', 'resized', 'switch-b', 'return-a', 'other-app', 'helper-pause', 'resume-a', 'finish']);

// 仅投影正式公开状态；姓名、ID和原始错误不会进入可视状态。
export function projectVisualAcceptance({ foreground: state, selectedContactId, expectedContactId }, now = Date.now()) {
  const observed = Date.parse(state.observedAt ?? '');
  const age = Number.isFinite(observed) ? now - observed : NaN;
  const fresh = age >= 0 && age <= 5000;
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
  } else if (fresh && state.wechatInFront === false) {
    headline = '正式 App 报告：微信非前台';
    classification = 'other';
  }
  const matched = classification === 'wechat' && state.confirmation === 'verified-binding'
    && Boolean(expectedContactId) && state.confirmedContactId === expectedContactId && selectedContactId === expectedContactId;
  return { headline, classification, matched,
    ageSeconds: Number.isFinite(age) && age >= 0 ? Math.round(age / 1000) : null,
    detail: matched ? '已通过正式绑定匹配测试联系人' : state.suspendedByHelperFocus ? '进入助手时暂停新观察，保留联系人内容'
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
