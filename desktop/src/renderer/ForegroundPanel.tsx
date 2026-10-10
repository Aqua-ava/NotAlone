import type { ContactSessionView } from './contact-session';
import { useEffect, useState } from 'react';
import { initialForegroundState, type ForegroundBridge, type ForegroundState } from '../shared/foreground-bridge';

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

export function ForegroundPanel({ state, session }: { state: ForegroundState; session?: ContactSessionView }) {
  const paused = state.phase === 'paused' || state.suspendedByHelperFocus;
  const message = paused ? '前台定位已暂停' : state.phase === 'observing' ? '正在定位前台会话'
    : state.phase === 'manual-required' ? '请手动确认本次联系人'
    : state.phase === 'unavailable' ? '前台定位暂不可用，请手动选择联系人' : '前台定位尚未观察';
  return <section aria-label="前台会话定位">
    <p role="status">{message}</p>
    {session?.state.selectedContactId && state.generationBlock !== null && <button
      onClick={() => void session.confirmContact(session.state.selectedContactId!, state.foregroundRevision)}>
      确认本次联系人
    </button>}
    {state.confirmation === 'manual-confirmed' && <p>本次联系人已由你确认。</p>}
    {state.confirmation === 'verified-binding' && <p>本次联系人已通过微信会话绑定确认。</p>}
    {session && state.suggestedContactId && <p>
      当前微信会话对应{session.state.contacts.find((item) => item.contactId === state.suggestedContactId)?.displayName}，已有编辑已保留。
      <button onClick={() => void session.confirmContact(state.suggestedContactId!, state.foregroundRevision)}>
        确认微信会话对应联系人
      </button>
    </p>}
    {session?.error && <p role="alert">{session.error}</p>}
    {state.suspendedByHelperFocus && <p>小窗在前台，暂停新的前台定位；已确认范围的后台同步独立运行。</p>}
  </section>;
}
