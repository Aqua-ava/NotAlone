import { DiagnosticSettings } from './DiagnosticSettings';
import type { BindingConsentState } from '../shared/binding-consent-bridge';
import { UsagePanel } from './UsagePanel';
import { useRevisionedSession } from './use-revisioned-session';
import { WechatSetupPanel } from './WechatSetupPanel';
import { ForegroundPanel, useForegroundState } from './ForegroundPanel';
import { ScreenPermissionPanel, useScreenPermission } from './ScreenPermissionPanel';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from './icons';
import { managerPages, type ManagerPage } from './pages';
import { DesktopControls, HelperPinControl, ShortcutWarning } from './DesktopControls';
import logo from './assets/logo.png';
import './style.css';
import './usage.css';
import './helper-layout.css';
import { BackendBadge, BackendConnectionNote, useBackendState } from './backend-status';
import { FirstFrameError } from './FirstFrameError';
import { SetupPanel } from './SetupPanel';
import { StartupReadiness, StartupSettings, useStartupState } from './StartupSettings';
import { ContactPicker, HelperContactPicker, useContactSession } from './contact-session';
import { ContactsPage } from './ContactsPage';
import { useChatHistoryPosition } from './use-chat-history-scroll';
import { ReplyCandidates, useReplySession } from './RewritePanel';
import { AssistantWorkspaceDraft } from './AssistantWorkspaceDraft';
import { MemoryPage } from './MemoryPage';
import { SyncControlPanel } from './SyncControlPanel';
import { SyncDiagnosticsPanel } from './SyncDiagnosticsPanel';
import { SkillLearningPage } from './SkillLearningPage';

const helper = window.location.hash === '#helper';
document.title = helper ? 'NotAlone · 输入小窗' : 'NotAlone · 管理后台';

export function App() {
  const backendRead = useBackendState();
  const backend = backendRead.state;
  const startupRead = useStartupState();
  const startup = startupRead.state;
  const permission = useScreenPermission();
  const contactSession = useContactSession();
  const readingPosition = useChatHistoryPosition(window.notalone.contactHistory, !helper);
  const replies = useReplySession(helper);
  const { state: consent } = useRevisionedSession<BindingConsentState>({ revision: -1, scopeRevision: 0, phase: 'offline',
    sessions: [], bindings: [], syncEnabled: null, sessionIssue: 'not-requested', busy: null, errorCode: null, notice: null }, window.notalone.bindings, !helper);
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => { workspace.current?.scrollTo({ top: 0 }); }, [replies.state.contactId, replies.state.scopeRevision]);
  const foregroundRead = useForegroundState(window.notalone.foreground, helper);
  const foreground = foregroundRead.state;
  const [error, setError] = useState('');
  const [page, setPage] = useState<ManagerPage>('contacts');
  const [selectingWechatContacts, setSelectingWechatContacts] = useState(false);
  function selectWechatContacts() { setSelectingWechatContacts(true); setPage('contacts'); }
  useEffect(() => { if (page !== 'contacts') setSelectingWechatContacts(false); }, [page]);
  const [syncDetailsContactId, setSyncDetailsContactId] = useState<string | null>(null);
  useEffect(() => { if (page !== 'contacts') setSyncDetailsContactId(null); }, [page]);
  async function showContactSync(contactId: string) {
    await contactSession.selectContact(contactId);
    setSyncDetailsContactId(contactId); setPage('contacts');
  }
  const [syncDiagnosticsOpen, setSyncDiagnosticsOpen] = useState(false);
  const syncDiagnostics = useRef<HTMLDetailsElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnostics = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (page === 'config' && advancedOpen && diagnosticsOpen) diagnostics.current?.scrollIntoView({ block: 'start' });
  }, [page, advancedOpen, diagnosticsOpen]);
  useEffect(() => {
    if (page === 'config' && advancedOpen && syncDiagnosticsOpen) syncDiagnostics.current?.scrollIntoView({ block: 'start' });
  }, [page, advancedOpen, syncDiagnosticsOpen]);
  function showSyncDiagnostics() {
    setPage('config'); setAdvancedOpen(true); setDiagnosticsOpen(false); setSyncDiagnosticsOpen(true);
  }
  function showDiagnostics() {
    setPage('config'); setAdvancedOpen(true); setDiagnosticsOpen(true); setSyncDiagnosticsOpen(false);
  }
  async function operate(operation: () => Promise<void>) {
    try { await operation(); setError(''); }
    catch { setError('窗口暂时无法打开，请从“窗口”菜单重试。'); }
  }
  const currentPage = managerPages[page];
  const navigationPage = page;
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
        正在加载这位联系人的助手讨论…
      </p>}
    <AssistantWorkspaceDraft contacts={contactSession} replies={replies} />
    <FirstFrameError message={foregroundRead.error} retry={foregroundRead.retry} />
    <div className="ime-status-line"><BackendBadge state={backend} compact /></div>
    <ReplyCandidates onDraftChange={(text,scope) => { void window.notalone.contacts.setDraft({...scope,text}).catch(() => {}); }} replies={replies} currentDraft={replies.state.contactId === contactSession.state.selectedContactId && replies.state.scopeRevision === contactSession.state.scopeRevision ? contactSession.state.draft : ''} />
    </div>
    <footer className="ime-footer">
      <span>由你修改并亲自发送</span>
      <HelperPinControl />
      <span>在回复下复制，再粘贴到聊天窗口发送</span>
    </footer>
    {error && <p role="alert">{error}</p>}
    <FirstFrameError message={backendRead.error} retry={backendRead.retry} />
    {contactSession.error && <p role="alert">{contactSession.error}<button className="button" onClick={() => void contactSession.retryRead()}>重试读取</button></p>}
  </main> : <div className="admin-layout">
    <aside className="admin-sidebar">
      <div className="admin-brand"><img src={logo} alt="NotAlone" /><small>让每一次表达，更像你自己</small></div>
      <span className="sidebar-label">关系与表达</span>
      <nav aria-label="管理导航">
        {(Object.keys(managerPages) as ManagerPage[]).map((key) => <button key={key}
          className={navigationPage === key ? 'active' : ''} aria-current={navigationPage === key ? 'page' : undefined}
          onClick={() => setPage(key)}><Icon name={managerPages[key].icon} />{managerPages[key].title}</button>)}
      </nav>
      <div className="sidebar-help"><Icon name="write" size={15} /><b>表达由你做主</b><p>候选可编辑，消息由你亲自发送。</p></div>
    </aside>
    <div className="admin-workspace">
      <header className="admin-topbar">
        <span>管理后台 <i>／</i> {currentPage.title}</span>
        <div><ContactPicker session={contactSession}
          onSelect={contactSession.selectContact} /><BackendBadge state={backend} />
          <button className="button primary" onClick={() => void operate(window.notalone.openHelper)}><Icon name="write" size={15} />打开输入小窗</button></div>
      </header>
      <ShortcutWarning />
      {contactSession.error && <p className="operation-error" role="alert">{contactSession.error}<button className="button" onClick={() => void contactSession.retryRead()}>重试读取</button></p>}
      <main className="manager-content">
        <div className="manager-title"><h1>{currentPage.title}</h1><p>{currentPage.description}</p></div>
        <BackendConnectionNote state={backend} startup={startup} onDiagnose={showDiagnostics} />
        <FirstFrameError message={backendRead.error} retry={backendRead.retry} />
        <FirstFrameError message={startupRead.error} retry={startupRead.retry} />
        {!(page === 'config' && advancedOpen && diagnosticsOpen)
          && <StartupReadiness state={startup} backend={backend} onConfigure={showDiagnostics} />}
        {page === 'config' && <SetupPanel />}
        <div hidden={page !== 'config'}><UsagePanel active={page === 'config'} /></div>
        {page === 'config' && <><ScreenPermissionPanel view={permission} /><DesktopControls /><DiagnosticSettings />
          <details className="startup-settings" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
            <summary>高级</summary>
            <p>手动文件导入入口已退役；已通过自动同步获取的资料无需重复导入。</p>
            <div ref={diagnostics}><StartupSettings state={startup} backend={backend} open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} /></div>
            <details ref={syncDiagnostics} className="startup-settings sync-diagnostics-entry" open={syncDiagnosticsOpen}
              onToggle={event => setSyncDiagnosticsOpen(event.currentTarget.open)}>
              <summary>同步诊断</summary>
              {advancedOpen && syncDiagnosticsOpen && <SyncDiagnosticsPanel bridge={window.notalone.syncControl} contacts={contactSession.state.contacts} />}
            </details>
          </details></>}
        {page === 'contacts' && <ContactsPage session={contactSession} syncDetailsContactId={syncDetailsContactId} readingPosition={readingPosition} navigate={setPage} initialSelection={selectingWechatContacts} onSelectionClosed={() => setSelectingWechatContacts(false)} />}
        <div hidden={page !== 'memory'}><MemoryPage session={contactSession} visible={page === 'memory'} /></div>
        <SkillLearningPage session={contactSession} visible={page === 'skillLearning'} />
        {page === 'sync' && <>
          <WechatSetupPanel bridge={window.notalone.wechatSetup} selectionOnly={consent.selectionOnly === true} onSelectContacts={selectWechatContacts}><SyncControlPanel bridge={window.notalone.syncControl} contacts={contactSession.state.contacts} currentContactId={contactSession.state.selectedContactId} onOpenContact={contactId => void showContactSync(contactId)} onOpenDiagnostics={showSyncDiagnostics} /></WechatSetupPanel>
        </>}
        {page !== 'config' && page !== 'contacts' && page !== 'memory' && page !== 'sync' && page !== 'skillLearning' && <section className="empty-panel" aria-label={currentPage.title}>
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
