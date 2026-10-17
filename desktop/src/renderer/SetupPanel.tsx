import { useEffect, useState } from 'react';
import type { SetupState } from '../shared/setup-bridge';
import './setup.css';

export function SetupPanel() {
  const [state, setState] = useState<SetupState>({ phase: 'offline', ownerReady: false, credentialsConfigured: false, revision: -1 });
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [key, setKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [officialRecovery, setOfficialRecovery] = useState(false), [confirmedOfficial, setConfirmedOfficial] = useState(false);
  useEffect(() => {
    let active = true;
    const receive = (next: SetupState) => {
      if (active) {
        setState((previous) => next.revision >= previous.revision ? next : previous);
        if (next.phase === 'offline') { setKey(''); setEditingKey(false); setOfficialRecovery(false); setConfirmedOfficial(false); }
      }
    };
    const unsubscribe = window.notalone.setup.onStateChanged(receive);
    void window.notalone.setup.getState().then(receive).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  return <section className="setup-panel" aria-label="本人身份与模型">
    <h2>本人身份与模型</h2>
    {state.phase === 'offline' ? <p>连接本机服务后，可查询并完成首次配置。</p>
      : state.phase === 'loading' ? <p>正在核对首次配置…</p>
        : state.phase === 'failed' ? <><p role="alert">首次配置状态暂时不可用，请重试。</p>
          <button className="button" onClick={() => void window.notalone.setup.refresh()}>重试查询配置</button></>
          : state.phase === 'saving' ? <p>正在保存配置…</p>
            : state.phase === 'restarting' ? <p>正在停读并重新加载配置…</p>
              : state.phase === 'restart-failed' ? <><p role="alert">后端重启未获确认。请检查受控配置后重试加载。</p>
                <button className="button" onClick={() => void window.notalone.setup.retryRestart()}>重试加载配置</button></>
          : <>
            <p>{state.ownerReady ? '本次运行的本人身份已就绪' : state.phase === 'needs-owner' ? '本人身份尚未初始化'
              : '检测到既有本人资料，但本次运行尚未绑定本人身份。请检查受控配置后重新连接。'}</p>
            <p>{state.credentialsConfigured ? 'DeepSeek 已配置' : 'DeepSeek 尚未配置'}</p>
            {state.officialDefaults === true && <p>模型接收方：DeepSeek 官方（https://api.deepseek.com），模型 deepseek-flash。</p>}
            {state.officialDefaults === false && <><p>当前保留了自定义模型或接收地址。仅更新密钥会继续使用原配置；旧模型若无法核验输入预算，生成会停止。</p>
              {state.phase === 'ready' && <button className="button" onClick={() => { setKey(''); setEditingKey(true); setOfficialRecovery(true); setConfirmedOfficial(false); }}>改用官方 DeepSeek 默认配置</button>}</>}
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
              ? <button className="button" onClick={() => { setKey(''); setEditingKey(true); }}>更新 DeepSeek 密钥</button>
              : <form onSubmit={(event) => {
                event.preventDefault();
                const submitted = key.trim(); setKey(''); setEditingKey(false); setError('');
                if (officialRecovery) {
                  if (!confirmedOfficial) return;
                  void window.notalone.setup.saveOfficialDeepSeekKey(submitted, true).catch(() => setError('官方模型配置未能保存，请重新确认并输入对应密钥。'));
                } else void window.notalone.setup.saveDeepSeekKey(submitted).catch(() => setError('DeepSeek 密钥未能保存，请重新输入后重试。'));
              }}>
                {officialRecovery && <><p>将模型与接收方改为 deepseek-flash／https://api.deepseek.com。请亲自输入此接收方对应的新密钥；原密钥不会被转发或自动复用。</p>
                  <label><input type="checkbox" checked={confirmedOfficial} onChange={(event) => setConfirmedOfficial(event.target.checked)} />我确认改用上述官方接收方，并为它重新输入密钥</label></>}
                <label htmlFor="deepseek-key">DeepSeek API Key</label>
                <input id="deepseek-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096}
                  value={key} onChange={(event) => setKey(event.target.value)} />
                <button className="button primary" type="submit" disabled={!key.trim() || officialRecovery && !confirmedOfficial}>{officialRecovery ? '保存官方模型与新密钥' : '保存 DeepSeek 密钥'}</button>
                <button className="button" type="button" onClick={() => setKey('')}>清空输入</button>
              </form>)}
          </>}
    {(error || state.errorCode === 'initialize-failed' || state.errorCode === 'credentials-failed') && <p role="alert">{error || (state.errorCode === 'credentials-failed'
      ? 'DeepSeek 密钥未能保存，请重新输入后重试。' : '本人初始化未完成，请重试。')}</p>}
    <div className="setup-privacy">
      <h3>存储与外部调用</h3>
      <p>本人身份、联系人资料、导入历史与已提交的候选会长期保存在本机 PostgreSQL。未提交的临时草稿不跨重启保存。</p>
      <p>DeepSeek 密钥写入本机受控配置文件，权限设为仅本人可读写。当前配置文件与业务资料未提供静态加密；请自行保护本机和备份。</p>
      <p>生成候选或提取关系资料时，DeepSeek 只接收当次范围内的必要文字：草稿或待回复消息，以及需要的少量同联系人历史、相关关系资料和本人资料。配置密钥本身不会发起模型调用。</p>
      <p>应用内删除不代表 DeepSeek 的外部副本已删除；供应商的留存与删除规则需单独核对。候选由你修改并亲自发送。</p>
    </div>
  </section>;
}
