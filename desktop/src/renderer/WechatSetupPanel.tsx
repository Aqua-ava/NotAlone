import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WechatSetupBridge, WechatSetupState } from '../shared/wechat-setup-bridge';
import { FirstFrameError } from './FirstFrameError';
import './bindings.css';
const initial: WechatSetupState = { phase: 'offline', accountId: null, failureCode: null, revision: -1 };
const toolFailureMessages: Record<string, string> = {
  wechat_tool_unavailable: '未找到可用的微信读取工具。请配置完整的读取工具后重新检测。',
  history_artifact_manifest_missing: '微信读取工具不完整，缺少校验清单。请修复读取工具后重新检测。',
  history_artifact_unverified: '微信读取工具完整性校验失败，文件可能缺失、损坏或版本不匹配。请修复读取工具后重新检测。',
  history_account_unavailable: '读取工具尚未配置可用的微信账号。请检查本机微信账号和读取工具配置后重新检测。',
  history_program_version_uncertified: '当前微信版本尚未通过支持核验，暂时无法连接。请使用受支持的微信版本后重新检测。',
  history_program_version_unavailable: '暂时无法确认微信版本。请确认微信正常运行后重新检测。',
  history_native_unavailable: '微信读取工具无法启动。请检查工具路径与本机运行权限后重新检测。',
  history_native_timeout: '微信账号检测超时。请确认微信正常运行后重新检测。',
  history_protocol_invalid: '微信读取工具返回了不兼容的结果。请使用与当前 App 匹配的读取工具后重新检测。',
  history_metadata_profile_unverified: '微信账号或数据来源尚未通过核验。请检查读取工具与当前微信版本是否匹配后重新检测。',
  history_source_unverified: '当前微信数据来源未通过核验，暂时无法连接。请检查读取工具的数据位置与账号配置后重新检测。',
  metadata_identity_unverified: '微信账号或数据来源尚未通过核验。请检查读取工具与当前微信版本是否匹配后重新检测。',
  metadata_identity_conflict: '检测期间微信账号或数据来源不一致，请重新检测。',
  history_source_changed: '检测期间微信数据来源发生变化，请重新检测。',
  history_scope_changed: '检测期间微信账号或数据来源发生变化，请重新检测。',
};
export function WechatSetupPanel({ bridge, children, selectionOnly: configuredSelectionOnly = false, onSelectContacts }: { bridge: WechatSetupBridge; children?: ReactNode; selectionOnly?: boolean; onSelectContacts?: () => void }) {
  const [state, setState] = useState(initial);
  const selectionOnly = configuredSelectionOnly || state.sourceReconfirmationRequired === true;
  const [sourceReconfirmed, setSourceReconfirmed] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const active = useRef(false);
  const selectingAfterConnection = useRef(false);
  const selectContacts = useRef(onSelectContacts);
  selectContacts.current = onSelectContacts;
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
    if (state.phase === 'connected' && selectingAfterConnection.current) {
      selectingAfterConnection.current = false;
      selectContacts.current?.();
    }
    if (['ready', 'conflict', 'needs_detection', 'failed'].includes(state.phase)) selectingAfterConnection.current = false;
  }, [state.phase, state.revision]);
  // 即使仍是同账号的 ready 候选，新发布代次也必须重新核对来源。
  useEffect(() => { setSourceReconfirmed(false); }, [state.revision]);
  async function operate(action: () => Promise<void>) {
    setError('');
    try { await action(); }
    catch { selectingAfterConnection.current = false; if (active.current) setError('页面状态已变化，请刷新后重新核对微信账号。'); }
  }
  const busy = ['loading', 'saving', 'restarting'].includes(state.phase);
  const blocked = ['tool_not_ready', 'tool_unavailable'].includes(state.phase);
  const canDetect = ['needs_detection', 'failed', 'tool_not_ready', 'tool_unavailable', 'conflict'].includes(state.phase);
  return <><section className="bindings-explanation" aria-label="首次连接微信">
    <div className="bindings-toolbar"><h2>{state.phase === 'connected' ? '微信账号已连接' : '连接微信'}</h2>
      <button className="button" disabled={busy || state.phase === 'offline'} onClick={() => void operate(() => bridge.refresh())}>刷新微信连接状态</button></div>
    {state.accountId && <p>{state.phase === 'ready' ? '读取工具配置的微信账号：' : state.phase === 'saving' ? '待连接的微信账号：' : '已关联的微信账号：'}<strong>{state.accountId}</strong></p>}
    {state.phase === 'needs_owner' && <p>请先到「设置」完成本机本人身份配置，再连接微信。</p>}
    {state.phase === 'needs_detection' && <p>先连接你的微信账号，再选择希望同步的联系人。</p>}
    {canDetect && <>
      {blocked && <p role="alert">{toolFailureMessages[state.failureCode ?? ''] ?? (state.phase === 'tool_unavailable'
        ? toolFailureMessages.wechat_tool_unavailable
        : '暂时无法完成微信账号核验。请重新检测；若仍失败，请查看「设置」中的本机诊断。')}</p>}
      {state.phase === 'conflict' && <p role="alert">{state.failureCode === 'identity_continuity_unverified'
        ? '本机微信数据来源已变化，暂时无法确认与原来源连续。旧读取授权尚未恢复；请先核验当前来源，再重新确认需要读取的会话。'
        : '微信账号与当前配置不一致，连接尚未完成。请核对本机微信读取配置后重新检测。'}</p>}
      {state.phase === 'failed' && <p role="alert">微信连接状态暂时无法核验，请刷新状态或重新检测。</p>}
      <p>检测只检查本机微信读取工具及配置账号，不读取会话列表或聊天正文，也不会开启同步。</p>
      <button className="button" onClick={() => void operate(() => bridge.detect())}>检测微信账号</button>
    </>}
    {state.phase === 'ready' && <>
      <p>请确认这是你要连接的微信账号；检测的是本机读取工具配置的账号，不代表当前微信前台的登录账号。</p>
      <p>确认连接后，将读取该账号的私聊会话列表，供你搜索和选择联系人。列表附带的消息摘要会立即丢弃，不保存或用于回复；选好并确认前，不会授权读取聊天正文。</p>
      {state.sourceReconfirmationRequired && <>
        <p role="alert">本机微信资料来源与原关联不同。当前资料会作为新的来源核验，已有资料保留；旧读取授权不会恢复，连接后仍需逐个确认会话。</p>
        <label><input type="checkbox" checked={sourceReconfirmed} onChange={event => setSourceReconfirmed(event.target.checked)} />我已核对当前微信账号，重新关联当前本机资料</label>
      </>}
      <p>下一步选择要同步的联系人，默认不勾选。可以先选几位开始，之后随时添加。</p>
      <p>昵称和备注只用于展示；按微信稳定身份关联，不按同名合并。群聊不在范围内，已单独停止或删除的会话不会自动恢复。</p>
      <p>{selectionOnly ? '读取还须满足已确认会话、当前账号资格、正文读取能力和总开关；候选回复仍由你亲自发送。' : '应用运行时才读取；关闭总开关或退出 App 会停止读取。候选回复仍由你亲自发送。'}</p>
      <button className="button primary" disabled={state.sourceReconfirmationRequired && !sourceReconfirmed}
        onClick={() => { selectingAfterConnection.current = true; void operate(() => bridge.confirm({ revision: state.revision, confirmed: true,
          mode: 'selected', historyAuthorized: false,
          ...(state.sourceReconfirmationRequired && sourceReconfirmed ? { sourceReconfirmed: true } : {}) })); }}>
        {state.sourceReconfirmationRequired ? '重新核验并连接当前来源' : '确认账号并选择联系人'}
      </button>
    </>}
    {state.phase === 'connected' && <p>账号已连接。你可以随时到「联系人」添加同步对象；没有确认的私聊不会获得读取授权。</p>}
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
