import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from './icons';
import { managerPages, type ManagerPage } from './pages';
import { DesktopControls, HelperPinControl, ShortcutWarning } from './DesktopControls';
import logo from './assets/logo.png';
import './style.css';
import { BackendBadge, BackendConnectionNote, useBackendState } from './backend-status';
import { SetupPanel } from './SetupPanel';
import { StartupReadiness, StartupSettings, useStartupState } from './StartupSettings';
import { CurrentContactLabel, HelperContactPicker, useContactSession } from './contact-session';
import { ContactsPage } from './ContactsPage';
import { ImportPage } from './ImportPage';
import { ReplyCandidates, RewriteInput, useReplySession } from './RewritePanel';
import { BindingConsentPage } from './BindingConsentPage';

const helper = window.location.hash === '#helper';
document.title = helper ? 'NotAlone · 输入小窗' : 'NotAlone · 管理后台';

function App() {
  const backend = useBackendState();
  const startup = useStartupState();
  const contactSession = useContactSession();
  const replies = useReplySession();
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
      <HelperContactPicker session={contactSession} />
      <div className="ime-modes" role="group" aria-label="写作方式">
        <button className="active" disabled>改写</button><button disabled>回复</button>
      </div>
      <button className="icon-button" aria-label="打开管理后台" title="打开管理后台"
        onClick={() => void operate(window.notalone.openManager)}><Icon name="contacts" size={16} /></button>
      <button className="icon-button" aria-label="隐藏输入小窗" title="隐藏输入小窗"
        onClick={() => void operate(window.notalone.hideWindow)}><Icon name="close" size={16} /></button>
    </header>
    <RewriteInput contacts={contactSession} replies={replies} />
    <div className="ime-status-line"><BackendBadge state={backend} compact />
      <div className="ime-contact-note"><CurrentContactLabel state={contactSession.state} /></div></div>
    <ReplyCandidates replies={replies} />
    <footer className="ime-footer">
      <span>由你修改并亲自发送</span>
      <HelperPinControl />
      <button disabled><Icon name="copy" size={13} />复制</button>
      <button className="copy-hide" disabled>复制并收起</button>
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
        <BackendConnectionNote state={backend} />
        {page === 'config' ? <StartupSettings state={startup} backend={backend} />
          : startup.phase !== 'ready' && <StartupReadiness state={startup} onConfigure={() => setPage('config')} />}
        {page === 'config' && <><SetupPanel /><DesktopControls /></>}
        {page === 'contacts' && <ContactsPage session={contactSession} navigate={setPage} />}
        {page === 'import' && <ImportPage session={contactSession} />}
        {page === 'sync' && <BindingConsentPage contacts={contactSession} navigate={setPage} />}
        {page !== 'config' && page !== 'contacts' && page !== 'import' && page !== 'sync' && <section className="empty-panel" aria-label={currentPage.title}>
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

createRoot(document.getElementById('root')!).render(<App />);
