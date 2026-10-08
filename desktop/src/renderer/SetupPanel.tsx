import { useEffect, useState } from 'react';
import type { SetupState } from '../shared/setup-bridge';
import './setup.css';

export function SetupPanel() {
  const [state, setState] = useState<SetupState>({ phase: 'offline', ownerReady: false, credentialsConfigured: false, revision: -1 });
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [key, setKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  useEffect(() => {
    let active = true;
    const receive = (next: SetupState) => {
      if (active) {
        setState((previous) => next.revision >= previous.revision ? next : previous);
        if (next.phase === 'offline') { setKey(''); setEditingKey(false); }
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
              : state.phase === 'restart-failed' ? <><p role="alert">配置已保存，但后端重启未获确认。请重试加载配置。</p>
                <button className="button" onClick={() => void window.notalone.setup.retryRestart()}>重试加载配置</button></>
          : <>
            <p>{state.ownerReady ? '本次运行的本人身份已就绪' : state.phase === 'needs-owner' ? '本人身份尚未初始化'
              : '检测到既有本人资料，但本次运行尚未绑定本人身份。请检查受控配置后重新连接。'}</p>
            <p>{state.credentialsConfigured ? 'DeepSeek 已配置' : 'DeepSeek 尚未配置'}</p>
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
                void window.notalone.setup.saveDeepSeekKey(submitted).catch(() => setError('DeepSeek 密钥未能保存，请重新输入后重试。'));
              }}>
                <label htmlFor="deepseek-key">DeepSeek API Key</label>
                <input id="deepseek-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096}
                  value={key} onChange={(event) => setKey(event.target.value)} />
                <button className="button primary" type="submit" disabled={!key.trim()}>保存 DeepSeek 密钥</button>
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
