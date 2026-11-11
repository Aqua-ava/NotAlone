import { useEffect, useState } from 'react';
import type { DiagnosticLogState } from '../shared/diagnostic-bridge';

export function DiagnosticSettings() {
  const [state, setState] = useState<DiagnosticLogState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void window.notalone.diagnosticLogs.getState().then(value => { if (active) setState(value); })
      .catch(() => { if (active) setError('诊断日志暂时无法读取，请重新打开设置。'); });
    return () => { active = false; };
  }, []);
  async function operate(action: 'toggle' | 'clear' | 'export') {
    if (busy || !state) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'toggle') setState(await window.notalone.diagnosticLogs.setEnabled(!state.enabled));
      else if (action === 'clear') { setState(await window.notalone.diagnosticLogs.clear()); setMessage('已清除诊断记录。短期删除保护信息将在14天内过期。'); }
      else { const result = await window.notalone.diagnosticLogs.exportBundle(); setMessage(result.status === 'saved' ? '诊断包已保存到你选择的本机位置。' : '已取消导出。'); }
    } catch { setError('诊断日志操作未完成，请稍后重试。'); }
    finally { setBusy(false); }
  }
  const size = !state ? '正在读取…' : state.bytes < 1024 * 1024 ? `${(state.bytes / 1024).toFixed(1)} KB` : `${(state.bytes / (1024 * 1024)).toFixed(1)} MB`;
  return <section className="startup-settings" aria-label="诊断日志">
    <h2>诊断日志</h2>
    <p>仅保存在本机，不会自动上传。记录操作编号、原因码和耗时，不包含聊天、图片或记忆正文。最多保留 14 天、50 MB，可随时清除。</p>
    <label><input type="checkbox" checked={state?.enabled ?? true} disabled={!state || busy} onChange={() => void operate('toggle')} />启用诊断日志</label>
    <p>日志占用（含短期删除保护信息）：<output aria-label="诊断日志占用">{size}</output></p>
    <div className="startup-actions">
      <button className="button" disabled={!state || busy || !state.available} onClick={() => void operate('clear')}>清除日志</button>
      <button className="button" disabled={!state || busy || !state.available} onClick={() => void operate('export')}>导出诊断包…</button>
    </div>
    {state?.available === false && <p role="status">本机日志暂不可用，不影响正常使用。</p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
