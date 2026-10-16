import { useEffect, useState } from 'react';
import { initialScreenPermissionState, type ScreenPermissionState } from '../shared/screen-permission-bridge';

export interface ScreenPermissionView {
  state: ScreenPermissionState;
  request(): void;
  recheck(): void;
}
export function useScreenPermission(): ScreenPermissionView {
  const [state, setState] = useState(initialScreenPermissionState);
  useEffect(() => {
    let active = true;
    const receive = (next: ScreenPermissionState) => {
      if (active) setState((previous) => next.revision >= previous.revision ? next : previous);
    };
    const bridge = window.notalone.screenPermission;
    const unsubscribe = bridge.onStateChanged(receive);
    void bridge.getState().then(receive).catch(() => {
      if (active) setState((previous) => ({ ...previous, phase: 'unavailable' }));
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  const operate = (operation: 'request' | 'recheck') => {
    void window.notalone.screenPermission[operation]().catch(() => {
      setState((previous) => ({ ...previous, phase: 'unavailable', busy: false }));
    });
  };
  return { state, request: () => operate('request'), recheck: () => operate('recheck') };
}

export function ScreenPermissionPanel({ view, compact = false }: { view: ScreenPermissionView; compact?: boolean }) {
  const { state } = view;
  return <section className="startup-readiness" aria-label="屏幕录制授权">
    {!compact && <h2>微信会话自动识别</h2>}
    <p role="status">{state.phase === 'granted' ? '屏幕录制权限已就绪。切回微信后重新识别当前会话。'
      : state.phase === 'missing' ? '需要屏幕录制权限，才能自动识别当前微信会话。'
      : state.phase === 'unavailable' ? '屏幕录制权限暂时无法核验，请核对当前 App 的内置探针后重试。'
      : '正在检查屏幕录制权限…'}</p>
    {state.phase !== 'granted' && <p>仅在本机分析前台微信窗口并识别会话名称，不保存或上传画面，不识别聊天正文。暂不授权时可手动选择联系人。</p>}
    {state.phase !== 'granted' && <button className="button" disabled={state.busy} onClick={view.request}>开启屏幕录制授权</button>}
    <button className="button" disabled={state.busy} onClick={view.recheck}>已授权，重新检测</button>
    {state.phase === 'missing' && <p>在系统设置“隐私与安全性 → 屏幕与系统音频录制”中允许当前 NotAlone。若系统未再次弹窗，请在该设置中开启；系统要求重新打开时，正常退出并重新打开 App。</p>}
  </section>;
}
