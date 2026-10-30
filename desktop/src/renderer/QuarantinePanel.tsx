import { useEffect, useState } from 'react';
import type { QuarantineSnapshot } from '../shared/quarantine-bridge';

export function QuarantinePanel() {
  const [snapshots,setSnapshots] = useState<QuarantineSnapshot[]>([]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function refresh() {
    setBusy(true);setError('');
    try { setSnapshots(await window.notalone.quarantine.list()); }
    catch {setError('未能读取本机隔离历史，请重试。');}
    finally {setBusy(false);}
  }
  useEffect(() => {
    void refresh();
    const focused=()=>void refresh();
    window.addEventListener('focus',focused);
    return ()=>window.removeEventListener('focus',focused);
  }, []);
  async function open(id:string) {
    setBusy(true);setError('');
    try {await window.notalone.quarantine.open(id);}
    catch {setError('未能打开隔离历史，请刷新后重试。');}
    finally {setBusy(false);}
  }
  return <section className="startup-settings" aria-label="未核验历史">
    <h2>未核验历史</h2>
    <p>这些文字仅保存在本机隔离区，尚未归入 App 联系人资料。禁止用于检索、记忆和回复生成。</p>
    <p>在独立窗口中查看或删除，不改变消息的未核验状态。</p>
    <button className="button" disabled={busy} onClick={()=>void refresh()}>刷新隔离记录</button>
    {!busy&&!snapshots.length&&!error&&<p>本机没有隔离记录。</p>}
    {snapshots.map(snapshot=><article key={snapshot.id}>
      <h3>{snapshot.displayName} · 未核验</h3>
      <p>{snapshot.recordCount} 条 · {new Date(snapshot.createdAt).toLocaleString()} · {snapshot.snapshotComplete?'快照遍历结束':snapshot.snapshotState==='running'?'正在导入，结束后可查看':snapshot.snapshotState==='ready'?'等待导入':'快照不完整'}</p>
      <button className="button" disabled={busy||snapshot.snapshotState==='running'||snapshot.snapshotState==='ready'} onClick={()=>void open(snapshot.id)}>查看与删除隔离文字</button>
    </article>)}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
