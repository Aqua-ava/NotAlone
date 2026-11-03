import { useEffect, useRef, useState } from 'react';
import type { ContactSummary } from '../shared/contact-session-bridge';
import type { ContactDeletionBridge, ContactDeletionItem, ContactDeletionState } from '../shared/contact-deletion-bridge';
import { useRevisionedSession } from './use-revisioned-session';

const initial: ContactDeletionState = {
  revision: -1, scopeRevision: 0, phase: 'offline', operations: [], busyId: null, error: null,
};
const noBridge: ContactDeletionBridge = {
  getState: async () => initial,
  refresh: async () => {},
  delete: async () => {},
  retry: async () => {},
  onStateChanged: () => () => {},
};

export function useContactDeletion(bridge?: ContactDeletionBridge) {
  return useRevisionedSession(initial, bridge ?? noBridge);
}

const phaseLabel: Record<ContactDeletionItem['phase'], string> = {
  requesting: '正在请求删除…',
  fenced: '已停止同步，正在保护联系人范围…',
  cleaning: '正在清理此联系人的本机资料…',
  verifying: '正在核验清理结果…',
  blocked: '删除失败，联系人资料尚未确认清除。',
  completed: '联系人删除已完成。',
  unconfirmed: '删除结果未知，可重试。',
};

export function ContactDeletionMenu({
  bridge, state, selected, contacts, scopeRevision, inline = false,
}: {
  bridge: ContactDeletionBridge; state: ContactDeletionState; selected: ContactSummary; contacts: ContactSummary[];
  scopeRevision: number;
  inline?: boolean;
}) {
  const [menu, setMenu] = useState<{ contactId: string; scopeRevision: number; connectionRevision: number } | null>(null);
  const [confirmation, setConfirmation] = useState<{ contactId: string; displayName: string; scopeRevision: number; connectionRevision: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuItem = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const latest = useRef({ contactId: selected.contactId, scopeRevision, connectionRevision: state.scopeRevision });
  latest.current = { contactId: selected.contactId, scopeRevision, connectionRevision: state.scopeRevision };
  useEffect(() => { setMenu(null); setConfirmation(null); }, [selected.contactId, scopeRevision, state.scopeRevision]);
  useEffect(() => {
    if (state.phase !== 'ready' || state.busyId) { setMenu(null); setConfirmation(null); }
  }, [state.phase, state.busyId]);
  const validMenu = state.phase === 'ready' && !state.busyId && menu?.contactId === selected.contactId && menu.scopeRevision === scopeRevision
    && menu.connectionRevision === state.scopeRevision;
  const validConfirmation = state.phase === 'ready' && !state.busyId && confirmation?.contactId === selected.contactId && confirmation.scopeRevision === scopeRevision
    && confirmation.connectionRevision === state.scopeRevision;
  const sameName = contacts.filter(contact => contact.displayName === selected.displayName).length > 1;
  useEffect(() => { if (validMenu) menuItem.current?.focus(); }, [validMenu]);
  useEffect(() => {
    if (!validConfirmation) return;
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    cancel.current?.focus();
    return () => { if (element.open) element.close(); trigger.current?.focus(); };
  }, [validConfirmation]);
  function askToDelete() {
    if ((!inline && !validMenu) || state.phase !== 'ready' || state.busyId) return;
    setMenu(null);
    setConfirmation({ contactId: selected.contactId, displayName: selected.displayName, scopeRevision, connectionRevision: state.scopeRevision });
  }
  async function confirmDelete() {
    const target = confirmation;
    const current = latest.current;
    if (!target || !validConfirmation || target.contactId !== current.contactId || target.scopeRevision !== current.scopeRevision
      || target.connectionRevision !== current.connectionRevision || state.phase !== 'ready' || state.busyId) {
      setConfirmation(null);
      return;
    }
    setConfirmation(null);
    try { await bridge.delete({ contactId: target.contactId, scopeRevision: target.scopeRevision, confirmed: true }); }
    catch { await bridge.refresh().catch(() => {}); }
  }
  return <div className="contact-deletion-menu">
    {inline ? <button ref={trigger} className="button contact-deletion-inline" type="button"
      disabled={state.phase !== 'ready' || Boolean(state.busyId)} onClick={askToDelete}>删除联系人</button>
    : <button ref={trigger} className="button contact-deletion-trigger" type="button" aria-label="联系人更多操作" title="联系人更多操作"
      aria-haspopup="menu" aria-expanded={Boolean(validMenu)} disabled={state.phase !== 'ready' || Boolean(state.busyId)}
      onClick={() => setMenu(validMenu ? null : { contactId: selected.contactId, scopeRevision, connectionRevision: state.scopeRevision })}>⋯</button>}
    {validMenu && <div className="contact-deletion-popover" role="menu" aria-label="联系人更多操作菜单"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null); trigger.current?.focus(); } }}>
      <button ref={menuItem} className="contact-deletion-menuitem" type="button" role="menuitem" onClick={askToDelete}>删除联系人</button>
    </div>}
    {validConfirmation && <dialog ref={dialog} className="contact-deletion-dialog" aria-label="确认删除联系人"
      onCancel={() => setConfirmation(null)} onClose={() => setConfirmation(null)}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const element = dialog.current;
        if (!element) return;
        const focusable = Array.from(element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }}>
        <h3>删除「{confirmation.displayName}」？</h3>
        <p>将停止同步并删除此人在 NotAlone 的全部资料。无法撤销，微信好友/原聊天不变。</p>
        <p className="contact-deletion-privacy">模型服务商的数据保留及删除方式以其政策为准，本机删除不会清除外部副本。</p>
        {sameName && <p className="contact-deletion-identity">联系人标识：<code>{confirmation.contactId}</code></p>}
        <div className="contact-deletion-dialog-actions">
          <button ref={cancel} className="button" type="button" onClick={() => setConfirmation(null)}>取消</button>
          <button className="button danger" type="button" onClick={() => void confirmDelete()}>删除联系人</button>
        </div>
    </dialog>}
  </div>;
}

export function ContactDeletionStatus({ bridge, state }: { bridge: ContactDeletionBridge; state: ContactDeletionState }) {
  const hasTask = state.operations.length > 0;
  const needsRefresh = state.phase === 'failed' || Boolean(state.error);
  if (!hasTask && !needsRefresh) return null;
  return <section className="contact-deletion-status" aria-label="联系人删除任务" aria-live="polite">
    <div className="contact-deletion-status-heading"><h3>联系人删除</h3>
      {needsRefresh && <button className="button" disabled={Boolean(state.busyId)} onClick={() => void bridge.refresh().catch(() => {})}>刷新删除状态</button>}
    </div>
    {needsRefresh && <p role="alert">删除任务状态暂不可用，请刷新后确认结果。</p>}
    {hasTask && <ul>{state.operations.map(item => <li key={item.id} data-phase={item.phase}>
      <div className="contact-deletion-operation-copy">
        <span>{item.phase === 'completed' ? phaseLabel.completed : phaseLabel[item.phase]}</span>
        {item.phase !== 'completed' && item.displayName && <small>{item.displayName}</small>}
      </div>
      {(item.phase === 'blocked' || item.phase === 'unconfirmed' || ['fenced', 'cleaning', 'verifying'].includes(item.phase))
        && <button className="button" type="button" disabled={Boolean(state.busyId)}
          onClick={() => void bridge.retry({ id: item.id, scopeRevision: state.scopeRevision, confirmed: true }).catch(() => {})}>
          {item.phase === 'blocked' || item.phase === 'unconfirmed' ? '重试删除' : '继续删除'}
        </button>}
    </li>)}</ul>}
  </section>;
}
