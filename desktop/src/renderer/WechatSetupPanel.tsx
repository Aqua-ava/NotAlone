import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WechatSetupBridge, WechatSetupState } from '../shared/wechat-setup-bridge';
import './bindings.css';
const initial: WechatSetupState = { phase: 'offline', accountId: null, failureCode: null, revision: -1 };
export function WechatSetupPanel({ bridge, children }: { bridge: WechatSetupBridge; children?: ReactNode }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    const receive = (next: WechatSetupState) => {
      if (active.current) setState(previous => next.revision > previous.revision ? next : previous);
    };
    const unsubscribe = bridge.onStateChanged(receive);
    void bridge.getState().then(receive).catch(() => {});
    void bridge.refresh().catch(() => { if (active.current) setError('微信连接状态暂时不可用，请重试。'); });
    return () => { active.current = false; unsubscribe(); };
  }, [bridge]);
  async function operate(action: () => Promise<void>) {
    setError('');
    try { await action(); }
    catch { if (active.current) setError('页面状态已变化，请刷新后重新核对微信账号。'); }
  }
  const busy = ['loading', 'saving', 'restarting'].includes(state.phase);
  const blocked = ['tool_not_ready', 'tool_unavailable'].includes(state.phase);
  const canDetect = ['needs_detection', 'failed', 'tool_not_ready', 'tool_unavailable', 'conflict'].includes(state.phase);
  return <><section className="bindings-explanation" aria-label="首次连接微信">
    <div className="bindings-toolbar"><h2>{state.phase === 'connected' ? '微信账号已连接' : '连接微信'}</h2>
      <button className="button" disabled={busy || state.phase === 'offline'} onClick={() => void operate(() => bridge.refresh())}>刷新微信连接状态</button></div>
    {state.accountId && <p>{state.phase === 'ready' ? '读取工具配置的微信账号：' : state.phase === 'saving' ? '待连接的微信账号：' : '已关联的微信账号：'}<strong>{state.accountId}</strong></p>}
    {state.phase === 'needs_owner' && <p>请先到「设置」完成本机本人身份配置，再连接微信。</p>}
    {state.phase === 'needs_detection' && <p>先检测本机微信读取工具可访问的账号，再核对并授权同步范围。</p>}
    {canDetect && <>
      {blocked && <p role="alert">微信读取工具尚未就绪。当前版本尚不能完成全新电脑的微信读取工具初始化；现在无法连接或开始同步。已有可用配置恢复后，可以重新检测。</p>}
      {state.phase === 'conflict' && <p role="alert">微信账号与当前配置不一致，连接尚未完成。请核对本机微信读取配置后重新检测。</p>}
      {state.phase === 'failed' && <p role="alert">微信连接状态暂时无法核验，请刷新状态或重新检测。</p>}
      <p>检测只检查本机微信读取工具及配置账号，不读取会话列表或聊天正文，也不会开启同步。</p>
      <button className="button" onClick={() => void operate(() => bridge.detect())}>检测微信账号</button>
    </>}
    {state.phase === 'ready' && <>
      <p>请确认这是你要连接的微信账号；此检测不代表当前微信前台的登录账号。确认后，会为此账号现有及以后新增的微信私聊自动建立对应联系人，并开启后台文字同步，无需逐个添加。</p>
      <p>昵称和备注只用于展示；按微信稳定身份关联，不按同名合并。群聊不在范围内，已单独停止或删除的会话不会自动恢复。</p>
      <p>应用运行时才读取；关闭总开关或退出 App 会停止读取。新关联从本次授权起同步，不自动导入更早的历史。</p>
      <button className="button primary" onClick={() => void operate(() => bridge.confirm({ revision: state.revision, confirmed: true }))}>确认连接并同步全部私聊</button>
    </>}
    {state.phase === 'connected' && <p>账号关联已保存；当前同步范围与总开关见下方设置。新授权的私聊会在后台自动关联，联系人出现后可在顶部搜索并切换。</p>}
    {(['restart_required', 'restart-failed'].includes(state.phase) || state.phase === 'offline' && state.failureCode === 'reload_failed') && <>
      <p role="status">授权已保存，需要重新加载本机服务以完成连接；无需再次授权。</p>
      <button className="button" onClick={() => void operate(() => bridge.retryRestart())}>重新加载连接</button>
    </>}
    {state.phase === 'offline' && <p>连接本机服务后查看微信接入状态。</p>}
    {busy && <p role="status">{state.phase === 'saving' ? '正在保存授权…' : state.phase === 'restarting' ? '授权已保存，正在重新加载连接…' : '正在核验微信连接状态…'}</p>}
    {error && <p role="alert">{error}</p>}
  </section>{state.phase === 'connected' && children}</>;
}
