import { useState } from 'react';

export function UpdateBackupDeletionNotice() {
  return <p>同时清除本 App 管理的全部更新备份，避免恢复已删除内容。原安装保留的资料、自行导出的副本和外部模型副本需另行删除。</p>;
}

export function UpdateBackupCleanupRecovery() {
  const [error, setError] = useState('');
  return <div><button className="button" onClick={() => {
    setError(''); void window.notalone.startup.revealUpdateBackup().catch(() => setError('备份目录暂时无法打开，请先查看恢复说明。'));
  }}>查看备份目录</button><button className="button" onClick={() => {
    setError(''); void window.notalone.startup.revealUpdateRecovery().catch(() => setError('恢复说明暂时无法打开。'));
  }}>查看备份清理恢复说明</button>{error && <p role="alert">{error}</p>}</div>;
}
