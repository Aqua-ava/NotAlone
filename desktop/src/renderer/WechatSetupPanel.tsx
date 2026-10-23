import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WechatSetupBridge, WechatSetupState } from '../shared/wechat-setup-bridge';
import { FirstFrameError } from './FirstFrameError';
import './bindings.css';
const initial: WechatSetupState = { phase: 'offline', accountId: null, failureCode: null, revision: -1 };
export function WechatSetupPanel({ bridge, children }: { bridge: WechatSetupBridge; children?: ReactNode }) {
  const [state, setState] = useState(initial);
  const [mode, setMode] = useState<'selected' | 'all_private'>('selected');
  const [historyAuthorized, setHistoryAuthorized] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    const receive = (next: WechatSetupState) => {
      if (active.current) setState(previous => next.revision > previous.revision ? next : previous);
    };
    const unsubscribe = bridge.onStateChanged(receive);
    void bridge.getState().then((next) => { setReadError(''); receive(next); })
      .catch(() => { if (active.current) setReadError('微信连接状态暂时无法读取，请重试。'); });
    void bridge.refresh().catch(() => { if (active.current) setError('微信连接状态暂时不可用，请重试。'); });
    return () => { active.current = false; unsubscribe(); };
  }, [bridge, readAttempt]);
  useEffect(() => {
    // 换账号或重新核验后重新作出选择，旧页面选择不能扩大新候选的授权。
    setMode('selected');
    setHistoryAuthorized(false);
  }, [state.accountId, state.phase]);
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
      <p>请确认这是你要连接的微信账号；此检测不代表当前微信前台的登录账号。确认连接表示允许读取该账号的会话列表以核验可读性并供你选择联系人；列表附带的消息摘要会立即丢弃，不保存或用于回复。</p>
      <fieldset><legend>同步范围</legend>
        <label><input type="radio" name="wechat-setup-scope" checked={mode === 'selected'} onChange={() => { setMode('selected'); setHistoryAuthorized(false); }} />仅我选择的私聊</label>
        <label><input type="radio" name="wechat-setup-scope" checked={mode === 'all_private'} onChange={() => { setMode('all_private'); setHistoryAuthorized(false); }} />当前账号的全部私聊</label>
      </fieldset>
      <p>{mode === 'selected' ? '连接后到「联系人」选择私聊并确认绑定；列表默认不选，不会自动授权其他会话。' : '确认后，会为此账号现有及以后新增的微信私聊自动建立对应联系人，并开启后台文字同步，无需逐个添加。'}</p>
      <p>昵称和备注只用于展示；按微信稳定身份关联，不按同名合并。群聊不在范围内，已单独停止或删除的会话不会自动恢复。</p>
      <label><input type="checkbox" disabled={mode === 'selected'} checked={historyAuthorized} onChange={event => setHistoryAuthorized(event.target.checked)} />同时读取所选范围在本机可用的历史消息</label>
      {mode === 'selected' && <p>选择会话时再确认历史范围：连接账号本身不授权未知会话的历史，请在添加联系人时选择会话并单独确认。</p>}
      <p>未开启历史读取时，仅从本次绑定起同步。扩大范围或新发现的会话不会沿用仅所选范围的历史授权；可在同步设置中另行确认。</p>
      <p>应用运行时才读取；关闭总开关或退出 App 会停止读取。候选回复仍由你亲自发送。</p>
      <button className="button primary" onClick={() => void operate(() => bridge.confirm({ revision: state.revision, confirmed: true, mode, historyAuthorized }))}>确认连接并开启同步</button>
    </>}
    {state.phase === 'connected' && <p>账号关联已保存；当前同步范围与总开关见下方设置。仅所选范围需要到「联系人」逐个确认；全部私聊范围会自动关联，联系人出现后可在顶部搜索并切换。</p>}
    {(['restart_required', 'restart-failed'].includes(state.phase) || state.phase === 'offline' && state.failureCode === 'reload_failed') && <>
      <p role="status">授权已保存，需要重新加载本机服务以完成连接；无需再次授权。</p>
      <button className="button" onClick={() => void operate(() => bridge.retryRestart())}>重新加载连接</button>
    </>}
    {state.phase === 'offline' && <p>连接本机服务后查看微信接入状态。</p>}
    {busy && <p role="status">{state.phase === 'saving' ? '正在保存授权…' : state.phase === 'restarting' ? '授权已保存，正在重新加载连接…' : '正在核验微信连接状态…'}</p>}
    {error && <p role="alert">{error}</p>}
    <FirstFrameError message={readError} retry={() => { setReadError(''); setReadAttempt((value) => value + 1); }} />
  </section>{state.phase === 'connected' && children}</>;
}
