import type { ContactSessionView } from './contact-session';
import { useEffect, useRef, useState } from 'react';
import { readInitialState } from './initial-read';
import { initialForegroundState, type ForegroundBridge, type ForegroundState } from '../shared/foreground-bridge';
import { foregroundFailureReason, isTransientForegroundContextChange, isUnsupportedForegroundConversation } from '../shared/foreground-failure.mjs';
import { ScreenPermissionPanel, type ScreenPermissionView } from './ScreenPermissionPanel';

export function useForegroundState(bridge: ForegroundBridge, enabled: boolean): { state: ForegroundState; error: string; retry: () => void } {
  const [state, setState] = useState<ForegroundState>(initialForegroundState);
  const [error, setError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const reading = useRef(false);
  const latestRevision = useRef(initialForegroundState.revision);
  const stateVersion = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const receive = (next: ForegroundState) => {
      if (!active || next.revision < latestRevision.current) return;
      latestRevision.current = next.revision; stateVersion.current++;
      setError(''); setState(next);
    };
    const unsubscribe = bridge.onStateChanged(receive);
    void readInitialState({ read: () => bridge.getState(), receive, reportError: setError,
      isActive: () => active, busy: reading, getStateVersion: () => stateVersion.current });
    return () => { active = false; unsubscribe(); };
  }, [bridge, enabled, readAttempt]);
  return { state, error, retry: () => setReadAttempt((value) => value + 1) };
}

export function ForegroundPanel({ state, session, permission }: { state: ForegroundState; session?: ContactSessionView; permission?: ScreenPermissionView }) {
  const selectionConfirmed = state.confirmation === 'manual-confirmed' && state.generationBlock === null;
  const failure = foregroundFailureReason(state.reason);
  const paused = state.phase === 'paused' || state.suspendedByHelperFocus && state.phase !== 'unavailable';
  const currentGroup = isUnsupportedForegroundConversation(state.reason);
  const message = currentGroup ? '群聊暂不支持，前台联系人匹配与新生成已暂停'
    : state.reason === 'sync_disabled' ? '同步总开关已关闭，前台识别暂停'
    : state.reason === 'wechat_not_in_front' ? '等待微信切到前台，请打开要聊天的私聊窗口'
    : state.reason === 'probe_warming' ? '微信 OCR 引擎正在准备，完成后自动重新识别'
    : state.reason === 'probe_warmup_timeout' ? '微信 OCR 引擎准备超时，正在等待下一次重试'
    : (state.phase === 'manual-required' || state.phase === 'unavailable' && state.unsupportedConversation) && failure
      && !['unmatched_requires_selection', 'ambiguous_requires_selection', 'manual_confirmation_required'].includes(state.reason ?? '')
      ? `${failure.message}；切回微信后会自动重试，也可在上方选择本次联系人`
    : state.unsupportedConversation ? '正在重新识别当前会话，请保持微信窗口在前台'
    : state.reason === 'unmatched_requires_selection' ? '当前会话未匹配到已确认绑定，请在上方选择联系人'
    : paused ? '前台定位已暂停' : state.phase === 'observing' ? '正在定位前台会话'
    : state.phase === 'confirmed' ? '已识别采集时的微信会话'
    : state.phase === 'manual-required' ? (state.recognizedName ? '已读到微信会话，请选择对应联系人' : '请在上方选择本次联系人')
    : state.phase === 'unavailable' && isTransientForegroundContextChange(state.reason)
      ? '微信前台或窗口发生变化，等待重新识别'
    : state.phase === 'unavailable' && state.reason === 'foreground_observation_busy'
      ? '本轮观察繁忙，等待重新识别'
    : state.phase === 'unavailable' && state.reason === 'foreground_application_unavailable'
      ? '系统前台状态未知，等待自动重试；也可在上方选择本次联系人'
    : state.phase === 'unavailable' && state.reason === 'screen_capture_permission_missing'
      ? '缺少屏幕录制权限，授权后可重新识别微信会话'
    : state.phase === 'unavailable' && failure && ['foreground_scope_unavailable', 'foreground_observation_unavailable', 'observation_unavailable', 'observation_timeout',
      'connection_changed', 'connection_unavailable', 'observation_cancelled'].includes(state.reason ?? '')
      ? failure.message
    : state.phase === 'unavailable' && failure ? `${failure.message}，等待自动重试；也可在上方选择本次联系人`
    : state.phase === 'unavailable' ? '前台定位暂不可用，等待自动重试；也可在上方选择联系人' : '前台定位尚未观察';
  return <section aria-label="前台会话定位">
    <p role="status">{selectionConfirmed ? '本次联系人已由你选择；切回微信后自动识别当前会话。' : message}</p>
    {selectionConfirmed && (failure || state.phase === 'unavailable' || currentGroup) && <p>{message}</p>}
    {state.reason === 'sync_disabled' && <p>请在管理后台的“同步设置”开启已有授权范围的同步，再回到微信会话。</p>}
    {permission && (state.reason === 'screen_capture_permission_missing' || permission.state.phase === 'missing')
      && <ScreenPermissionPanel view={permission} compact />}
    {!selectionConfirmed && !paused && !state.unsupportedConversation && state.recognizedName && <p>
      微信会话：{state.recognizedName}
      {state.recognitionConfidence !== null && <small> · 识别置信度 {Math.round(state.recognitionConfidence * 100)}%</small>}
    </p>}
    {currentGroup && <p>原私聊内容已保留，已授权联系人的后台同步继续；回到已确认私聊后重新识别。</p>}
    {!state.unsupportedConversation && state.generationBlock !== null && session?.state.selectedContactId && <p>
      当前联系人未确认；以下保留内容属于{session.state.contacts.find((item) => item.contactId === session.state.selectedContactId)?.displayName}，请明确选择后再生成。
    </p>}
    {!state.unsupportedConversation && session?.state.selectedContactId && state.generationBlock !== null && <button
      onClick={() => void session.confirmManualContact(session.state.selectedContactId!)}>
      确认本次联系人
    </button>}
    {state.confirmation === 'verified-binding' && <p>已按会话名称匹配到配置账号的已有联系人。</p>}
    {(state.reason === 'confirmed_active_binding_name_match' || state.reason === 'confirmed_active_binding_emoji_fallback')
      && <p>上方是原始 OCR 分数；低分本身不阻止名单中的唯一匹配。</p>}
    {!selectionConfirmed && (state.phase === 'confirmed' || state.recognizedName) && state.observedAt && <p>
      识别结果对应 <time dateTime={state.observedAt}>{new Date(state.observedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time> 采集时的会话；之后的切换可能尚未反映。
    </p>}
    {session?.error && <p role="alert">{session.error}</p>}
    {state.suspendedByHelperFocus && <p>小窗在前台，暂停新的前台定位；已确认范围的后台同步独立运行。</p>}
    <p>粘贴内容只用于本次候选与助手讨论，不会自动成为长期关系记忆。消息由你亲自发送。</p>
  </section>;
}
