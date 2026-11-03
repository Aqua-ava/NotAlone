import { useEffect, useState } from 'react';
import { isAiServiceBaseUrl } from '../shared/ai-service-configuration';
import type { SetupState } from '../shared/setup-bridge';
import { FirstFrameError } from './FirstFrameError';
import { useSettingsDraft } from './use-settings-draft';
import './setup.css';

export function SetupPanel() {
  const [state, setState] = useState<SetupState>({ phase: 'offline', ownerReady: false, credentialsConfigured: false, revision: -1 });
  const [name = '', setName, discardName, savingName, saveName] = useSettingsDraft<string>('setup-owner-name', state.phase === 'needs-owner' ? '' : undefined);
  useEffect(() => { if (state.ownerReady) discardName(); }, [state.ownerReady]);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const [key, setKey] = useState('');
  const [baseUrl = 'https://api.deepseek.com', setBaseUrl, discardBaseUrl, savingConfiguration, saveConfiguration] = useSettingsDraft('setup-base-url',
    state.revision >= 0 && state.phase === 'ready' ? state.baseUrl ?? 'https://api.deepseek.com' : undefined);
  useEffect(() => { setKey(''); }, [state.baseUrl]);
  useEffect(() => {
    let active = true;
    const receive = (next: SetupState) => {
      if (active) {
        setState((previous) => next.revision >= previous.revision ? next : previous);
        setReadError('');
        if (next.phase === 'offline') { setKey(''); }
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
            <p>使用 DeepSeek Messages 兼容接口，沿用当前模型。更改地址后，请重新输入该服务对应的 API Key。</p>
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
              if (savingName) return;
              void saveName(() => window.notalone.setup.initializeOwner(name)).then(() => discardName()).catch(() => setError('本人初始化未完成，请重试。'));
            }}>
              <label htmlFor="owner-name">本人展示名称</label>
              <input id="owner-name" autoComplete="off" maxLength={100} disabled={savingName} value={name} onChange={(event) => setName(event.target.value)} />
              <button className="button primary" type="submit" disabled={savingName}>{savingName ? '正在初始化…' : '初始化本人'}</button>
            </form>}
            {state.phase === 'ready' && <form onSubmit={(event) => {
                event.preventDefault();
                if (savingConfiguration) return;
                const submitted = {baseUrl: baseUrl.trim(), apiKey: key.trim()};
                if (!isAiServiceBaseUrl(submitted.baseUrl) || !submitted.apiKey) return;
                setKey(''); setError('');
                void saveConfiguration(() => window.notalone.setup.saveDeepSeekConfiguration(submitted)).then(() => discardBaseUrl())
                  .catch(() => setError('AI 服务配置未能保存，请重新输入密钥后重试。'));
              }}>
                <label htmlFor="deepseek-base-url">Base URL</label>
                <input id="deepseek-base-url" type="url" autoComplete="off" spellCheck={false} maxLength={2048} disabled={savingConfiguration}
                  placeholder="https://api.deepseek.com" value={baseUrl} onChange={(event) => {setBaseUrl(event.target.value);setKey('');}} />
                <label htmlFor="deepseek-key">API Key</label>
                <input id="deepseek-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096} disabled={savingConfiguration}
                  value={key} onChange={(event) => setKey(event.target.value)} />
                <button className="button primary" type="submit" disabled={savingConfiguration || !isAiServiceBaseUrl(baseUrl.trim()) || !key.trim()}>{savingConfiguration ? '正在保存配置…' : '保存 AI 服务配置'}</button>
              </form>}
          </>}
    {state.errorCode === 'configuration-environment-override' && state.phase !== 'restart-failed' && <p role="alert">启动环境覆盖或禁止读取受控配置文件，本次更改未保存。请由启动方更新环境后重试。</p>}
    {(error || state.errorCode === 'initialize-failed' || state.errorCode === 'credentials-failed') && <p role="alert">{error || (state.errorCode === 'credentials-failed'
      ? 'AI 服务配置未能保存，请重新输入密钥后重试。' : '本人初始化未完成，请重试。')}</p>}
    <FirstFrameError message={readError} retry={() => { setReadError(''); setReadAttempt((value) => value + 1); }} />
  </section>;
}
