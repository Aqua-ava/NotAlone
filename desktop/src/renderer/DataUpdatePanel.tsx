import { useEffect, useRef, useState } from 'react';
import type { DatabaseUpdateState } from '../shared/startup-bridge';

const messages: Record<string, string> = {
  update_stop_unconfirmed: '旧服务尚未确认停止，请先完成连接状态中的停止操作。',
  adoption_writers_present: '还有其他程序连接这份资料。请退出旧版 App 或其他资料工具，再继续。',
  migration_busy: '另一个资料更新仍在进行，请等它结束后继续。',
  update_disk_space_insufficient: '本机可用空间不足，尚未更新原资料。请腾出空间后重试。',
  update_target_changed: '原资料或配置已发生变化，已停止这次更新。请重新打开 App 核验。',
  update_schema_mismatch: '这份资料的结构与已知版本不一致，已保留原资料。请查看本机备份并使用原版 App 恢复。',
  baseline_missing: '这份资料缺少可核验的版本记录，不能直接更新。请保留原资料并使用原版 App 恢复。',
  baseline_invalid: '原资料的版本凭证不完整，不能直接更新。请保留原资料并使用原版 App 恢复。',
  migration_history_mismatch: '资料版本记录有差异，不能直接更新。请保留原资料并使用原版 App 恢复。',
  backup_restore_failed: '备份或恢复校验未完成。原资料仍保留，请检查磁盘空间后重试。',
  restore_mismatch: '恢复校验发现差异，尚未更新原资料。请查看保留的备份。',
  update_backup_invalid: '本机备份的校验未通过，已停止继续更新。原资料仍保留。',
  update_backup_incomplete: '上次备份未完成，原资料仍保留。请查看备份位置和恢复说明。',
  update_source_changed: '更新期间原资料有新变化，已停止切换。原资料与已生成的备份均保留。',
  update_interrupted: '上次更新被中断，资料和已完成的检查点已保留。可以继续更新。',
  update_reconnect_failed: '资料已完成处理，但服务尚未重新连接。请重新打开 App 继续核验。',
};

export function useDataUpdateState(): DatabaseUpdateState {
  const [state, setState] = useState<DatabaseUpdateState>({ phase: 'idle', revision: -1, hasBackup: false, external: false, canContinue: false, canRecheck: false });
  useEffect(() => {
    const receive = (next: DatabaseUpdateState) => setState(previous => next.revision >= previous.revision ? next : previous);
    const dispose = window.notalone.startup.onDataUpdateChanged(receive);
    void window.notalone.startup.getDataUpdateState().then(receive).catch(() => {});
    return dispose;
  }, []);
  return state;
}

export function DataUpdatePanel({ state }: { state: DatabaseUpdateState }) {
  const [error, setError] = useState('');
  const submitting = useRef(false);
  if (state.phase === 'idle') return null;
  const running = state.phase === 'running';
  const steps = { stopping: '正在确认停止旧服务…', preparing: '正在准备本机资料服务…',
    verifying: '正在备份、验证恢复能力并完成兼容更新…', updating: '正在完成兼容更新…', reconnecting: '正在重新连接资料服务…' };
  async function update() {
    if (submitting.current) return;
    submitting.current = true;
    setError('');
    try { await window.notalone.startup.backupAndUpdate(); }
    catch { setError('尚未完成更新，请按当前提示处理。'); }
    finally { submitting.current = false; }
  }
  return <section className="startup-settings" aria-label="保留资料更新">
    <h2>{state.phase === 'complete' ? '资料更新已完成' : '保留你的已有资料'}</h2>
    <p role={state.phase === 'failed' ? 'alert' : 'status'}>{state.phase === 'checking' ? '正在只读重新检查资料…' : running ? steps[state.step || 'verifying']
      : state.phase === 'complete' ? state.hasBackup ? '本机备份已通过恢复校验，资料与原有读取范围已保留。' : '资料更新已完成，当前没有可用的更新备份。'
        : state.phase === 'failed' ? messages[state.code || ''] || '资料更新尚未完成，原资料和已生成的备份仍保留。'
          : '继续使用前，需要完成一次兼容更新。'}</p>
    {!running && state.phase !== 'checking' && state.phase !== 'complete' && <p>点击后先停止写入，在本机备份并实际验证恢复，再更新与重连。联系人、聊天、关系资料、绑定和同步开关都会保留。{state.external ? '原安装的资料与配置也会保留，新版使用 App 自带的本机服务。' : ''}</p>}
    <div className="startup-actions">
      {state.canContinue && <button className="button primary" onClick={() => void update()}>{state.phase === 'failed' ? '继续备份更新' : '备份并完成更新'}</button>}
      {state.phase === 'failed' && state.canRecheck && <button className="button" onClick={() => { setError(''); void window.notalone.startup.recheckDataUpdate().catch(() => setError('资料尚未完成核验，请查看恢复说明。')); }}>重新检查资料</button>}
      {state.phase === 'failed' && <button className="button" onClick={() => { void window.notalone.startup.revealUpdateRecovery().catch(() => setError('恢复说明暂时无法打开。')); }}>查看恢复说明</button>}
      {state.hasBackup && <button className="button" onClick={() => { void window.notalone.startup.revealUpdateBackup().catch(() => setError('备份位置暂时无法打开，请稍后重试。')); }}>查看本机备份</button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
