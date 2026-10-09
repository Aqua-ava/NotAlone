import type { ForegroundState } from '../shared/foreground-bridge';

export function ForegroundPanel({ state }: { state: ForegroundState }) {
  const paused = state.phase === 'paused' || state.suspendedByHelperFocus;
  const message = paused ? '前台定位已暂停' : state.phase === 'observing' ? '正在定位前台会话'
    : state.phase === 'manual-required' ? '请手动确认本次联系人'
    : state.phase === 'unavailable' ? '前台定位暂不可用，请手动选择联系人' : '前台定位尚未观察';
  return <section aria-label="前台会话定位">
    <p role="status">{message}</p>
    {state.suspendedByHelperFocus && <p>小窗在前台，暂停新的前台定位；已确认范围的后台同步独立运行。</p>}
  </section>;
}
