import { useState } from 'react';

export function UpdateBackupCleanupRecovery() {
  const [error, setError] = useState('');
  return <div><button className="button" onClick={() => {
    setError(''); void window.notalone.startup.revealUpdateBackup().catch(() => setError('备份目录暂时无法打开，请先查看恢复说明。'));
  }}>查看备份目录</button><details><summary>查看备份清理恢复说明</summary>
    <p>本次删除尚未完成。点击“查看备份目录”可在 Finder 打开本 App 的固定历史副本目录。</p>
    <p>未知、归属不明或未完成的副本请先保留并核验；不要用这些副本覆盖当前数据库。</p>
    <p>仅对已确认不再需要的损坏副本，在 Finder 移至废纸篓后，返回重试原删除操作。无法确认时请保留现场并取得支持。</p>
  </details>{error && <p role="alert">{error}</p>}</div>;
}
