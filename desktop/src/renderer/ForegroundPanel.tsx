import type { ContactSessionView } from './contact-session';
import { useEffect, useState } from 'react';
import { initialForegroundState, type ForegroundBridge, type ForegroundState } from '../shared/foreground-bridge';
import { foregroundFailureReason, isTransientForegroundContextChange } from '../shared/foreground-failure.mjs';
import { ScreenPermissionPanel, type ScreenPermissionView } from './ScreenPermissionPanel';

export function useForegroundState(bridge: ForegroundBridge, enabled: boolean): ForegroundState {
  const [state, setState] = useState<ForegroundState>(initialForegroundState);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const receive = (next: ForegroundState) => {
      if (active) setState((previous) => next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = bridge.onStateChanged(receive);
    void bridge.getState().then(receive).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge, enabled]);
  return state;
}

export function ForegroundPanel({ state, session, permission, manualRelease = false, manualInput = false }: { state: ForegroundState; session?: ContactSessionView; permission?: ScreenPermissionView; manualRelease?: boolean; manualInput?: boolean }) {
  if (state.manualInput || manualRelease || manualInput) return <section aria-label="手动输入联系人确认"><p role="status">手动输入模式 · {state.manualInput && state.confirmation === 'manual-confirmed' ? '本次联系人已由你确认' : '请明确选择本次联系人'}</p>
    <p>粘贴内容只用于本次候选与助手讨论，不会自动成为长期关系记忆。消息由你亲自发送。</p>
    {(!state.manualInput || state.generationBlock) && session?.state.selectedContactId && <button onClick={() => void session.confirmManualContact(session.state.selectedContactId!)}>确认手动输入联系人</button>}
    {state.manualInput && session?.state.selectedContactId && <button
      onClick={() => void session.resumeForeground(state.foregroundRevision)}>恢复微信会话识别</button>}
    {session?.error && <p role="alert">{session.error}</p>}
  </section>;
  const failure = foregroundFailureReason(state.reason);
  const paused = state.phase === 'paused' || state.suspendedByHelperFocus;
  const message = state.unsupportedConversation ? '群聊暂不支持，前台联系人匹配与新生成已暂停'
    : state.reason === 'sync_disabled' ? '同步总开关已关闭，前台识别暂停'
    : state.reason === 'wechat_not_in_front' ? '等待微信切到前台，请打开要聊天的私聊窗口'
    : state.reason === 'unmatched_requires_selection' ? '当前会话未匹配到已确认绑定，请在上方选择联系人'
    : paused ? '前台定位已暂停' : state.phase === 'observing' ? '正在定位前台会话'
    : state.phase === 'confirmed' ? '已识别采集时的微信会话'
    : state.phase === 'manual-required' ? (state.recognizedName ? '已读到微信会话，请选择对应联系人' : '请手动确认本次联系人')
    : state.phase === 'unavailable' && isTransientForegroundContextChange(state.reason)
      ? '微信前台或窗口发生变化，等待重新识别'
    : state.phase === 'unavailable' && state.reason === 'foreground_observation_busy'
      ? '本轮观察繁忙，等待重新识别'
    : state.phase === 'unavailable' && state.reason === 'foreground_application_unavailable'
      ? '系统前台状态未知，请手动选择本次联系人'
    : state.phase === 'unavailable' && state.reason === 'screen_capture_permission_missing'
      ? '缺少屏幕录制权限，授权后可重新识别微信会话'
    : state.phase === 'unavailable' && failure ? `${failure.message}，请手动选择本次联系人`
    : state.phase === 'unavailable' ? '前台定位暂不可用，请手动选择联系人' : '前台定位尚未观察';
  return <section aria-label="前台会话定位">
    <p role="status">{message}</p>
    {state.reason === 'sync_disabled' && <p>请在管理后台的“同步设置”开启已有授权范围的同步，再回到微信会话。</p>}
    {session?.state.selectedContactId && <button onClick={() => void session.confirmManualContact(session.state.selectedContactId!)}>切换为手动输入</button>}
    {permission && (state.reason === 'screen_capture_permission_missing' || permission.state.phase === 'missing')
      && <ScreenPermissionPanel view={permission} compact />}
    {!paused && !state.unsupportedConversation && state.recognizedName && <p>
      微信会话：{state.recognizedName}
      {state.recognitionConfidence !== null && <small> · 识别置信度 {Math.round(state.recognitionConfidence * 100)}%</small>}
    </p>}
    {state.unsupportedConversation && <p>原私聊内容已保留，已授权联系人的后台同步继续；回到已确认私聊后重新识别。</p>}
    {!state.unsupportedConversation && state.generationBlock !== null && session?.state.selectedContactId && <p>
      当前联系人未确认；以下保留内容属于{session.state.contacts.find((item) => item.contactId === session.state.selectedContactId)?.displayName}，请明确选择后再生成。
    </p>}
    {!state.unsupportedConversation && session?.state.selectedContactId && state.generationBlock !== null && <button
      onClick={() => void session.confirmContact(session.state.selectedContactId!, state.foregroundRevision)}>
      确认本次联系人
    </button>}
    {state.confirmation === 'manual-confirmed' && <p>本次联系人已由你确认。</p>}
    {state.confirmation === 'verified-binding' && <p>本次联系人已通过微信会话绑定确认。</p>}
    {(state.reason === 'confirmed_active_binding_name_match' || state.reason === 'confirmed_active_binding_emoji_fallback')
      && <p>根据会话名单唯一匹配，已核验既有绑定；上方分数仍是原始 OCR 结果。</p>}
    {(state.phase === 'confirmed' || state.suggestedContactId || state.recognizedName) && state.observedAt && <p>
      识别结果对应 <time dateTime={state.observedAt}>{new Date(state.observedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time> 采集时的会话；之后的切换可能尚未反映。
    </p>}
    {session && state.suggestedContactId && <p>
      采集时的微信会话对应{session.state.contacts.find((item) => item.contactId === state.suggestedContactId)?.displayName}，已有编辑已保留。
      <button onClick={() => void session.confirmContact(state.suggestedContactId!, state.foregroundRevision)}>
        确认微信会话对应联系人
      </button>
    </p>}
    {session?.error && <p role="alert">{session.error}</p>}
    {state.suspendedByHelperFocus && <p>小窗在前台，暂停新的前台定位；已确认范围的后台同步独立运行。</p>}
  </section>;
}
