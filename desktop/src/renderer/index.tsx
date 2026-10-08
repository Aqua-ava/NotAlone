import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from './icons';
import { managerPages, type ManagerPage } from './pages';
import logo from './assets/logo.png';
import './style.css';

const helper = window.location.hash === '#helper';
document.title = helper ? 'NotAlone · 输入小窗' : 'NotAlone · 管理后台';

function App() {
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
      <button className="contact-pill" disabled><span className="status-dot" />联系人未确认<Icon name="chevron" size={12} /></button>
      <div className="ime-modes" role="group" aria-label="写作方式">
        <button className="active" disabled>改写</button><button disabled>回复</button>
      </div>
      <button className="icon-button" aria-label="打开管理后台" title="打开管理后台"
        onClick={() => void operate(window.notalone.openManager)}><Icon name="contacts" size={16} /></button>
      <button className="icon-button" aria-label="隐藏输入小窗" title="隐藏输入小窗"
        onClick={() => void operate(window.notalone.hideWindow)}><Icon name="close" size={16} /></button>
    </header>
    <div className="ime-input">
      <textarea aria-label="草稿" rows={1} placeholder="连接完成并确认联系人后，就可以写下你的意思…" disabled />
      <button className="generate-button" aria-label="生成候选" title="生成候选" disabled><Icon name="sparkle" size={18} /></button>
    </div>
    <p className="ime-status" role="status">尚未连接，暂时无法生成候选。</p>
    <section className="horizontal-candidates" aria-label="候选回复">
      <p>暂无候选</p><small>准备好你的意思，再选择合适的表达。</small>
    </section>
    <footer className="ime-footer">
      <span>由你修改并亲自发送</span>
      <button disabled><Icon name="copy" size={13} />复制</button>
      <button className="copy-hide" disabled>复制并收起</button>
    </footer>
    {error && <p role="alert">{error}</p>}
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
        <div><span className="connection-status" role="status"><span className="status-dot" />尚未连接</span>
          <button className="button primary" onClick={() => void operate(window.notalone.openHelper)}><Icon name="write" size={15} />打开输入小窗</button></div>
      </header>
      <main className="manager-content">
        <div className="manager-title"><h1>{currentPage.title}</h1><p>{currentPage.description}</p></div>
        <section className="connection-note" aria-label="连接状态"><Icon name="config" size={20} /><div>
          <b>本机服务尚未连接</b><p>联系人、资料与生成暂时不可用。</p></div></section>
        <section className="empty-panel" aria-label={currentPage.title}>
          <div className="empty-symbol"><Icon name={currentPage.icon} size={32} /></div>
          <h2>{currentPage.emptyTitle}</h2><p>{currentPage.emptyDescription}</p>
          <button className="button" disabled>{currentPage.action}</button>
        </section>
        {error && <p className="operation-error" role="alert">{error}</p>}
      </main>
      <footer className="admin-footer">每次回复都对应已确认的联系人。关闭窗口后，可从“窗口”菜单重新打开。</footer>
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
