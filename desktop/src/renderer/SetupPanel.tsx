import { useEffect, useState } from 'react';
import type { SetupState } from '../shared/setup-bridge';
import { FirstFrameError } from './FirstFrameError';
import './setup.css';

export function SetupPanel() {
  const [state, setState] = useState<SetupState>({ phase: 'offline', ownerReady: false, credentialsConfigured: false, revision: -1 });
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const [key, setKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [officialRecovery, setOfficialRecovery] = useState(false), [confirmedOfficial, setConfirmedOfficial] = useState(false);
  useEffect(() => {
    let active = true;
    const receive = (next: SetupState) => {
      if (active) {
        setState((previous) => next.revision >= previous.revision ? next : previous);
        setReadError('');
        if (next.phase === 'offline') { setKey(''); setEditingKey(false); setOfficialRecovery(false); setConfirmedOfficial(false); }
      }
    };
    const unsubscribe = window.notalone.setup.onStateChanged(receive);
    void window.notalone.setup.getState().then(receive)
      .catch(() => { if (active) setReadError('首次配置状态暂时无法读取，请重试。'); });
    return () => { active = false; unsubscribe(); };
  }, [readAttempt]);
  return <section className="setup-panel" aria-label="AI 服务">
    <h2>AI 服务</h2>
    {state.phase === 'offline' ? <p>连接本机服务后，可查询并完成首次配置。</p>
      : state.phase === 'loading' ? <p>正在核对首次配置…</p>
        : state.phase === 'failed' ? <><p role="alert">首次配置状态暂时不可用，请重试。</p>
          <button className="button" onClick={() => void window.notalone.setup.refresh()}>重试查询配置</button></>
          : state.phase === 'saving' ? <p>正在保存配置…</p>
            : state.phase === 'restarting' ? <p>正在停读并重新加载配置…</p>
              : state.phase === 'restart-failed' ? <><p role="alert">{state.errorCode === 'configuration-environment-override' ? '已保存的配置仍被启动环境覆盖。请由启动方更新或移除对应环境设置并重启服务后，再重试加载。' : state.configurationPending ? '配置已保存，但尚未确认在本次运行生效。请重试加载；外部启动的服务需先由其启动方重启。' : '后端重启未获确认。请检查受控配置后重试加载。'}</p>
                <button className="button" onClick={() => void window.notalone.setup.retryRestart()}>重试加载配置</button></>
          : <>
            {!state.ownerReady && <p>{state.phase === 'needs-owner' ? '本人身份尚未初始化'
              : state.recoverableOwner ? '检测到唯一已有本人，确认后恢复原身份。'
                : '检测到既有本人资料，但无法唯一确认本次身份。请检查受控配置，不会自动选择本人。'}</p>}
            <p>{state.credentialsConfigured ? 'DeepSeek · 已配置' : 'DeepSeek · 尚未配置'}</p>
            <p>密钥和模型配置保存后需重启本机服务才会生效；保存本身不会发起模型调用。</p>
            {state.officialDefaults === false && <><p>当前保留了自定义模型或接收地址。仅更新密钥会继续使用原配置；旧模型若无法核验输入预算，生成会停止。</p>
              {state.phase === 'ready' && <button className="button" onClick={() => { setKey(''); setEditingKey(true); setOfficialRecovery(true); setConfirmedOfficial(false); }}>改用官方 DeepSeek 默认配置</button>}</>}
            {state.phase === 'identity-unbound' && state.recoverableOwner && <button className="button" onClick={() => {
              setError('');
              void window.notalone.setup.recoverExistingOwner().catch(() => setError('本人配置恢复未完成，请重试。'));
            }}>恢复已有本人配置</button>}
            {state.phase === 'identity-unbound' && <button className="button" onClick={() => {
              setError('');
              void window.notalone.setup.reloadControlledConfiguration().catch(() => setError('后端重启未获确认。请检查受控配置后重试加载。'));
            }}>重新加载受控配置</button>}
            {state.phase === 'needs-owner' && <form onSubmit={(event) => {
              event.preventDefault(); setError('');
              void window.notalone.setup.initializeOwner(name).catch(() => setError('本人初始化未完成，请重试。'));
            }}>
              <label htmlFor="owner-name">本人展示名称</label>
              <input id="owner-name" autoComplete="off" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
              <button className="button primary" type="submit">初始化本人</button>
            </form>}
            {state.phase === 'ready' && (state.credentialsConfigured && !editingKey
              ? <button className="button" onClick={() => { setKey(''); setEditingKey(true); }}>更换密钥</button>
              : <form onSubmit={(event) => {
                event.preventDefault();
                const submitted = key.trim(); setKey(''); setEditingKey(false); setError('');
                if (officialRecovery) {
                  if (!confirmedOfficial) return;
                  void window.notalone.setup.saveOfficialDeepSeekKey(submitted, true).catch(() => setError('官方模型配置未能保存，请重新确认并输入对应密钥。'));
                } else void window.notalone.setup.saveDeepSeekKey(submitted).catch(() => setError('DeepSeek 密钥未能保存，请重新输入后重试。'));
              }}>
                {!officialRecovery && state.officialDefaults === true && <p>模型接收方：DeepSeek 官方（https://api.deepseek.com），模型 deepseek-flash。</p>}
                {officialRecovery && <><p>将模型与接收方改为 deepseek-flash／https://api.deepseek.com。请亲自输入此接收方对应的新密钥；原密钥不会被转发或自动复用。</p>
                  <label><input type="checkbox" checked={confirmedOfficial} onChange={(event) => setConfirmedOfficial(event.target.checked)} />我确认改用上述官方接收方，并为它重新输入密钥</label></>}
                <label htmlFor="deepseek-key">DeepSeek API Key</label>
                <input id="deepseek-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096}
                  value={key} onChange={(event) => setKey(event.target.value)} />
                <button className="button primary" type="submit" disabled={!key.trim() || officialRecovery && !confirmedOfficial}>{officialRecovery ? '保存官方模型与新密钥' : '保存 DeepSeek 密钥'}</button>
                <button className="button" type="button" onClick={() => setKey('')}>清空输入</button>
              </form>)}
          </>}
    {state.errorCode === 'configuration-environment-override' && state.phase !== 'restart-failed' && <p role="alert">启动环境覆盖或禁止读取受控配置文件，本次更改未保存。请由启动方更新环境后重试。</p>}
    {(error || state.errorCode === 'initialize-failed' || state.errorCode === 'credentials-failed') && <p role="alert">{error || (state.errorCode === 'credentials-failed'
      ? 'DeepSeek 密钥未能保存，请重新输入后重试。' : '本人初始化未完成，请重试。')}</p>}
    <FirstFrameError message={readError} retry={() => { setReadError(''); setReadAttempt((value) => value + 1); }} />
  </section>;
}
