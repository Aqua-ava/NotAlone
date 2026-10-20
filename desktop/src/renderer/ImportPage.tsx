import { useEffect, useRef, useState } from 'react';
import type { ImportState, ImportTarget } from '../shared/import-bridge';
import type { ContactSessionView } from './contact-session';
import './imports.css';

const initial: ImportState = { revision: -1, selectionRevision: 0, phase: 'unavailable', fileName: null, target: null, preview: null, error: null,
  submission: null, syncReloadPhase: 'idle' };
const taskStatusLabels = { queued: '等待处理', running: '正在处理', verifying: '正在核验', succeeded: '处理完成', failed: '处理失败', cancelled: '处理已停止' };
const stepLabels = { parse: '解析资料', normalize: '规范消息', extract_memory: '提取关系资料', index: '更新关系目录', verify: '核验处理结果' };
const stepStatusLabels = { pending: '等待', running: '执行中', succeeded: '成功', retryable: '等待自动重试', failed: '失败', cancelled: '已停止' };
const kindLabels: Record<string, string> = {
  text: '文字', quote: '引用', image: '图片占位', sticker: '表情占位', transfer: '转账记录', system: '系统记录',
  voice: '语音占位', voip: '通话记录', video: '视频占位', channel_video: '视频号占位', file: '文件占位',
  link: '链接', location: '位置记录', miniprogram: '小程序', card: '名片', red_packet: '红包记录',
  forward_chat: '转发记录', app: '应用消息',
};

export function ImportPage({ session }: { session: ContactSessionView }) {
  const [state, setState] = useState(initial);
  const [name, setName] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(state);
  useEffect(() => {
    let active = true;
    const receive = (next: ImportState) => {
      if (!active || next.revision < latest.current.revision) return;
      if (next.selectionRevision !== latest.current.selectionRevision) { setChecked(false); setError(''); }
      if (!next.target) setName('');
      else if (next.target.kind === 'new' && (latest.current.revision < 0 || latest.current.target?.kind !== 'new')) setName(next.target.displayName);
      latest.current = next;
      setState(next);
    };
    const unsubscribe = window.notalone.imports.onStateChanged(receive);
    void window.notalone.imports.getState().then(receive).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  const busy = ['choosing', 'previewing', 'confirming', 'submitting'].includes(state.phase) || state.syncReloadPhase === 'restarting';
  const available = state.phase !== 'unavailable' && session.state.directoryPhase === 'ready';
  const canPreview = available && !busy && !!state.fileName && !!state.target
    && (state.target.kind !== 'new' || !!state.target.displayName.trim());
  async function operate(action: () => Promise<void>) {
    const revision = latest.current.selectionRevision;
    try { await action(); }
    catch { if (revision === latest.current.selectionRevision) setError('本次文件或联系人已变化，请重新预览并确认。'); }
  }
  const setTarget = (target: ImportTarget) => void operate(() => window.notalone.imports.setTarget(target));
  const preview = state.preview;
  return <section className="import-panel" aria-label="历史文件导入">
    <div className="import-intro"><h2>先核对，再保存</h2>
      <p>仅接受单联系人 JSONL；本次选择只用于预览，确认后再进行导入。NotAlone 不运行导出工具，也不读取其他文件。</p>
      <p>仅在需要补充自动同步未覆盖的旧记录、且你已持有单联系人 JSONL 文件时使用。已同步的记录无需重复导入；没有文件时，可返回联系人目录手动输入文字。</p></div>
    {!available && <p className="import-note">请先连接本机服务并完成本次运行的本人配置，再选择历史文件。</p>}
    <div className="import-file"><button className="button" disabled={!available || busy}
      onClick={() => void operate(() => window.notalone.imports.chooseFile())}>选择历史文件</button>
      <span>{state.fileName ?? '尚未选择文件'}</span></div>
    <div className="import-target"><label>资料归属联系人<select aria-label="资料归属联系人"
      value={state.target?.kind === 'new' ? 'new' : state.target?.contactId ?? ''} disabled={!available || busy}
      onChange={(event) => setTarget(event.target.value === 'new' ? { kind: 'new', displayName: name } : { kind: 'existing', contactId: event.target.value })}>
      <option value="" disabled>由你选择，不自动匹配</option><option value="new">新建联系人</option>
      {session.state.contacts.map((entry) => <option key={entry.contactId} value={entry.contactId}>{entry.displayName}</option>)}
    </select></label>
    {state.target?.kind === 'new' && <label>新联系人名称<input aria-label="新联系人名称" value={name} maxLength={100} disabled={busy}
      onChange={(event) => { setName(event.target.value); setTarget({ kind: 'new', displayName: event.target.value }); }} /></label>}
    <button className="button primary" disabled={!canPreview}
      onClick={() => void operate(() => window.notalone.imports.preview({ selectionRevision: latest.current.selectionRevision }))}>预览资料范围</button></div>
    {busy && <p className="import-note" aria-live="polite">{state.syncReloadPhase === 'restarting' ? '正在认证停读并重新加载同步服务…' : state.phase === 'submitting' ? '正在原子保存本次确认的资料…' : state.phase === 'choosing' ? '等待你选择文件…' : state.phase === 'confirming' ? '正在重新核对这份文件…' : '正在校验单联系人资料…'}</p>}
    {preview && <section className="import-preview" aria-label="单联系人资料预览">
      <div className="import-preview-heading"><h3>单联系人资料预览</h3><span>尚未保存资料</span></div>
      <dl className="import-summary"><div><dt>资料范围</dt><dd>{preview.recordCount} 条记录</dd></div>
        <div><dt>归属联系人</dt><dd>{preview.targetName}</dd></div>
        <div><dt>本人渠道身份</dt><dd>{preview.ownerIdentity.observedName}<small>{preview.ownerIdentity.externalId}</small></dd></div>
        <div><dt>联系人渠道身份</dt><dd>{preview.contactIdentity.observedName}<small>{preview.contactIdentity.externalId}</small></dd></div></dl>
      <ul className="import-kinds" aria-label="记录类型统计">{Object.entries(preview.kindCounts).map(([kind, count]) => <li key={kind}>{kindLabels[kind] ?? '其他记录'}：{count} 条</li>)}</ul>
      <p>非文字记录仅表示来源中的载体，不代表已完成转写或形成关系记忆。</p>
      <label className="import-confirm"><input type="checkbox" checked={checked} disabled={busy || state.phase === 'confirmed'}
        onChange={(event) => setChecked(event.target.checked)} />我已核对本人渠道身份、联系人和这份文件的资料范围</label>
      <button className="button primary" disabled={!checked || state.phase !== 'previewed'}
        onClick={() => void operate(() => window.notalone.imports.confirmPreview({ selectionRevision: latest.current.selectionRevision }))}>确认本次预览</button>
    </section>}
    {state.phase === 'confirmed' && <div className="import-confirmed"><p role="status">已确认本次预览，尚未保存资料。</p>
      <button className="button primary" onClick={() => void operate(() => window.notalone.imports.submit({ selectionRevision: latest.current.selectionRevision }))}>正式导入这份资料</button>
      <button className="button" onClick={() => void operate(() => window.notalone.imports.cancelConfirmation({ selectionRevision: latest.current.selectionRevision }))}>取消本次确认</button></div>}
    {state.phase === 'submitting' && <div className="import-note"><p>停止查看或切换联系人不会撤回已交给后端的保存；再次导入必须重新预览确认。</p>
      <button className="button" onClick={() => void operate(() => window.notalone.imports.cancelConfirmation({ selectionRevision: latest.current.selectionRevision }))}>停止查看本次提交</button></div>}
    {state.submission?.receipt && <section className="import-progress" aria-label="本次导入处理">
      <h3>资料已保存，处理状态另行核验</h3>
      <p>{state.submission.targetName} · {state.submission.fileName}</p>
      <p role="status">新增 {state.submission.receipt.importedCount} 条消息，已存在 {state.submission.receipt.skippedDuplicates} 条消息。</p>
      <p>后台关系提取失败不会回滚已保存的消息。处理期间可明确选择联系人，使用手动输入发起候选回复。</p>
      <p>重新提交须重新预览确认同一份文件和联系人；原新建名称与归属仍有效时会复用已保存结果。归属变化时请明确选择既有联系人。</p>
      <div className="import-task-toolbar"><h4>{state.submission.task ? taskStatusLabels[state.submission.task.status] : '处理状态待核验'}</h4>
        <button className="button" disabled={!available || !!state.submission.taskBusy} onClick={() => void operate(() => window.notalone.imports.refreshTask({ selectionRevision: latest.current.selectionRevision }))}>刷新处理状态</button></div>
      {state.submission.taskBusy && <p aria-live="polite">{state.submission.taskBusy === 'refresh' ? '正在读取持久任务状态…' : state.submission.taskBusy === 'retry' ? '正在恢复原失败任务…' : '正在启动原排队任务…'}</p>}
      {state.submission.task && <>
        <p>当前步骤：{stepLabels[state.submission.task.step]} · 已记录自动重试 {state.submission.task.retryCount} 次</p>
        <ol className="import-task-steps" aria-label="原导入任务步骤">{state.submission.task.steps.map((step) => <li key={step.name}>
          <div><strong>{stepLabels[step.name]}</strong><span>{stepStatusLabels[step.status]}</span></div>
          <p>已处理 {step.processedCount} / {step.totalCount} · 尝试 {step.attemptCount} 次</p>
          {step.error && <p className="import-task-error">{step.error}</p>}</li>)}</ol>
        {state.submission.task.error && <p className="import-task-error" role="alert">{state.submission.task.error}</p>}
        {state.submission.task.status === 'succeeded' && <p className="import-complete" role="status">原任务全部步骤和最终核验已成功。</p>}
        {state.submission.task.status === 'failed' && <><p>重试复用原任务，保留已成功步骤；不会重新导入资料。</p>
          <button className="button primary" disabled={!available || !!state.submission.taskBusy} onClick={() => void operate(() => window.notalone.imports.retryTask({ selectionRevision: latest.current.selectionRevision }))}>重试原失败任务</button></>}
        {state.submission.task.status === 'queued' && <><p>若资源或模型配置尚未就绪，请先修正配置。重新开启服务不会自动恢复旧队列。</p>
          <button className="button" disabled={!available || !!state.submission.taskBusy} onClick={() => void operate(() => window.notalone.imports.runTask({ selectionRevision: latest.current.selectionRevision }))}>继续原排队任务</button></>}
        {state.submission.task.status === 'cancelled' && <p>后端已停止此任务；请查看对应来源状态，不能将它视为处理完成。</p>}
      </>}
      {state.submission.taskError && <p role="alert">{state.submission.taskError}</p>}
      <section aria-label="归属联系人来源"><h4>这位联系人的来源资料</h4>
        {state.submission.sources === null ? <p>{state.submission.sourcesError ? '来源状态暂时无法核验，请刷新处理状态。' : '正在读取来源资料…'}</p>
          : <ul className="import-sources">{state.submission.sources.map((source) => <li key={source.sourceId}>{source.fileName} · {source.recordCount} 条 · {source.status === 'active' ? '有效来源' : '来源正在或已经清除，请在来源管理核验结果'}</li>)}</ul>}</section>
      {state.submission.syncReloadNeeded && <div className="import-sync-reload"><p>同步宿主尚未装配。首份导入确认的本人渠道身份须重新加载服务后才能用于同步。导入不会自动授权会话；重启只沿用既有确认范围和总开关，旧排队任务须重新查看并明确继续。</p>
        <button className="button" disabled={!available || !!state.submission.taskBusy} onClick={() => void operate(() => window.notalone.imports.reloadSyncHost({ selectionRevision: latest.current.selectionRevision }))}>认证停读并重新加载同步服务</button></div>}
    </section>}
    {state.syncReloadPhase === 'ready' && <p className="import-confirmed" role="status">同步服务已重新加载。请在“联系人 → 添加微信联系人”中主动选择并确认会话授权；如需查看原导入任务，请重新预览确认同一份文件。</p>}
    {state.syncReloadPhase === 'failed' && <div className="import-note"><p role="alert">同步服务重新加载结果尚未确认。停读未确认时不会另起实例；请检查连接或配置后重试。</p>
      <button className="button" onClick={() => void operate(() => window.notalone.imports.reloadSyncHost({ selectionRevision: latest.current.selectionRevision }))}>重试重新加载同步服务</button></div>}
    {(state.error || error) && <p className="import-note" role="alert">{state.error ?? error}</p>}
  </section>;
}
