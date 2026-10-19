import { ForegroundPanel, useForegroundState } from './ForegroundPanel';
import { ScreenPermissionPanel, useScreenPermission } from './ScreenPermissionPanel';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from './icons';
import { managerPages, type ManagerPage } from './pages';
import { DesktopControls, HelperPinControl, ShortcutWarning } from './DesktopControls';
import logo from './assets/logo.png';
import './style.css';
import './helper-layout.css';
import { BackendBadge, BackendConnectionNote, useBackendState } from './backend-status';
import { SetupPanel } from './SetupPanel';
import { StartupReadiness, StartupSettings, useStartupState } from './StartupSettings';
import { CurrentContactLabel, HelperContactPicker, useContactSession } from './contact-session';
import { ContactsPage } from './ContactsPage';
import { ImportPage } from './ImportPage';
import { ReplyCandidates, useReplySession } from './RewritePanel';
import { UnifiedReplyWorkspace } from './UnifiedReplyWorkspace';
import { MemoryPage } from './MemoryPage';
import { BindingConsentPage } from './BindingConsentPage';
import { SyncControlPanel } from './SyncControlPanel';
import { SkillLearningPage } from './SkillLearningPage';
import { PrioritySyncStatus } from './PrioritySyncStatus';

const helper = window.location.hash === '#helper';
document.title = helper ? 'NotAlone · 输入小窗' : 'NotAlone · 管理后台';

export function App() {
  const backend = useBackendState();
  const startup = useStartupState();
  const permission = useScreenPermission();
  const contactSession = useContactSession();
  const replies = useReplySession();
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => { workspace.current?.scrollTo({ top: 0 }); }, [replies.state.mode, replies.state.options.inputKind]);
  const foreground = useForegroundState(window.notalone.foreground, helper);
  const [error, setError] = useState('');
  const [page, setPage] = useState<ManagerPage>('contacts');
  async function operate(operation: () => Promise<void>) {
    try { await operation(); setError(''); }
    catch { setError('窗口暂时无法打开，请从“窗口”菜单重试。'); }
  }
  const currentPage = managerPages[page];
  return helper ? <main className="ime-pane">
    <header className="ime-header">
      <img className="ime-logo" src={logo} alt="NotAlone" />
      <HelperContactPicker session={contactSession} foreground={foreground} />
      <button className="icon-button" aria-label="打开管理后台" title="打开管理后台"
        onClick={() => void operate(window.notalone.openManager)}><Icon name="contacts" size={16} /></button>
      <button className="icon-button" aria-label="隐藏输入小窗" title="隐藏输入小窗"
        onClick={() => void operate(window.notalone.hideWindow)}><Icon name="close" size={16} /></button>
    </header>
    <div className="ime-workspace" ref={workspace}>
    <div className="helper-context"><ForegroundPanel state={foreground} session={contactSession} permission={permission} /></div>
    {replies.state.contactId && replies.state.contactId === contactSession.state.selectedContactId
      && replies.state.savedSession?.phase === 'loading' && <p role="status" className="rewrite-privacy">
        已切换联系人，正在恢复这位联系人的历史讨论与回复…
      </p>}
    <UnifiedReplyWorkspace contacts={contactSession} replies={replies} />
    <PrioritySyncStatus contactId={contactSession.state.selectedContactId} bridge={window.notalone.syncControl} />
    {replies.state.messageNotice.phase === 'connected' && <>
      {replies.state.messageNotice.needsRefresh && <p role="status">消息提醒有待核对，请主动刷新消息。生成依据仍是原快照。</p>}
      {replies.state.messageNotice.changed && <p role="status">当前联系人有新消息，生成依据仍是原快照。由你决定是否重新生成。</p>}
      {!replies.state.messageNotice.needsRefresh && !replies.state.messageNotice.changed && <p role="status">新消息提醒已连接。</p>}
    </>}
    {replies.state.messageNotice.phase === 'interrupted' && <p role="status">消息提醒已中断，请重连消息提醒；连接恢复后会自动核对最新消息。</p>}
    {replies.state.messageNotice.phase === 'interrupted' && <button onClick={() => void replies.reconnectMessages()}>重连消息提醒</button>}
    {replies.state.mode === 'rewrite_draft' && (replies.state.messageNotice.changed || replies.state.messageNotice.needsRefresh)
      && <button disabled={replies.state.messages.phase === 'loading'} onClick={() => void replies.loadMessages()}>刷新消息</button>}
    <div className="ime-status-line"><BackendBadge state={backend} compact />
      <div className="ime-contact-note"><CurrentContactLabel state={contactSession.state} /></div></div>
    <ReplyCandidates replies={replies} currentDraft={contactSession.state.draft} />
    </div>
    <footer className="ime-footer">
      <span>由你修改并亲自发送</span>
      <HelperPinControl />
      <span>在回复下复制，再粘贴到聊天窗口发送</span>
    </footer>
    {error && <p role="alert">{error}</p>}
    {contactSession.error && <p role="alert">{contactSession.error}</p>}
  </main> : <div className="admin-layout">
    <aside className="admin-sidebar">
      <div className="admin-brand"><img src={logo} alt="NotAlone" /><small>让每一次表达，更像你自己</small></div>
      <span className="sidebar-label">关系与表达</span>
      <nav aria-label="管理导航">
        {(Object.keys(managerPages) as ManagerPage[]).map((key) => <button key={key}
          className={page === key ? 'active' : ''} aria-current={page === key ? 'page' : undefined}
          onClick={() => setPage(key)}><Icon name={managerPages[key].icon} />{managerPages[key].title}</button>)}
      </nav>
      <div className="sidebar-help"><Icon name="write" size={15} /><b>表达由你做主</b><p>候选可编辑，消息由你亲自发送。</p></div>
    </aside>
    <div className="admin-workspace">
      <header className="admin-topbar">
        <span>管理后台 <i>／</i> {currentPage.title}</span>
        <div><CurrentContactLabel state={contactSession.state} /><BackendBadge state={backend} />
          <button className="button primary" onClick={() => void operate(window.notalone.openHelper)}><Icon name="write" size={15} />打开输入小窗</button></div>
      </header>
      <ShortcutWarning />
      <main className="manager-content">
        <div className="manager-title"><h1>{currentPage.title}</h1><p>{currentPage.description}</p></div>
        <BackendConnectionNote state={backend} startup={startup} />
        {page === 'config' ? <StartupSettings state={startup} backend={backend} />
          : startup.phase !== 'ready' && <StartupReadiness state={startup} onConfigure={() => setPage('config')} />}
        {(page === 'config' || startup.mode === 'managed' && backend.phase === 'connected') && <SetupPanel />}
        {page === 'config' && <><ScreenPermissionPanel view={permission} /><DesktopControls /></>}
        {page === 'contacts' && <ContactsPage session={contactSession} navigate={setPage} manualRelease={startup.mode === 'managed'} />}
        {page === 'import' && <ImportPage session={contactSession} />}
        {page === 'memory' && <MemoryPage session={contactSession} navigate={setPage} />}
        {page === 'skillLearning' && <SkillLearningPage session={contactSession} />}
        {page === 'sync' && <><SyncControlPanel bridge={window.notalone.syncControl} />
          {startup.mode === 'managed' ? <div><button className="button primary" onClick={() => setPage('contacts')}>选择联系人并手动输入</button>
            <button className="button" onClick={() => setPage('import')}>导入单联系人资料</button></div>
            : <BindingConsentPage contacts={contactSession} navigate={setPage} />}</>}
        {page !== 'config' && page !== 'contacts' && page !== 'import' && page !== 'memory' && page !== 'sync' && page !== 'skillLearning' && <section className="empty-panel" aria-label={currentPage.title}>
          <div className="empty-symbol"><Icon name={currentPage.icon} size={32} /></div>
          <h2>{currentPage.emptyTitle}</h2><p>{currentPage.emptyDescription}</p>
          <button className="button" disabled>{currentPage.action}</button>
        </section>}
        {error && <p className="operation-error" role="alert">{error}</p>}
      </main>
      <footer className="admin-footer">每次回复都对应已确认的联系人。关闭窗口后，可从“窗口”菜单重新打开。</footer>
    </div>
  </div>;
}

if (!import.meta.hot?.data.root) {
  const root = createRoot(document.getElementById('root')!);
  if (import.meta.hot) import.meta.hot.data.root = root;
  root.render(<App />);
}
