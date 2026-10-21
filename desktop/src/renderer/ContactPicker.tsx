import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ContactSessionView } from './contact-session';

export function ContactPicker({ session, disabled = false, onSelect = session.selectContact }: {
  session: ContactSessionView; disabled?: boolean; onSelect?: (contactId: string) => Promise<unknown>;
}) {
  const { contacts, selectedContactId, directoryPhase, scopeRevision } = session.state;
  const unavailable = disabled || directoryPhase !== 'ready' || contacts.length === 0;
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null), composing = useRef(false);
  const listId = useId();
  const selected = contacts.find(contact => contact.contactId === selectedContactId);
  const sameNames = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const contact of contacts) {
      const ids = names.get(contact.displayName) ?? [];
      ids.push(contact.contactId); names.set(contact.displayName, ids);
    }
    return names;
  }, [contacts]);
  const needle = query.trim().toLocaleLowerCase();
  const results = contacts.filter(contact => contact.displayName.toLocaleLowerCase().includes(needle));
  const active = results.find(contact => contact.contactId === activeId);
  const expanded = open && !unavailable;

  function close(restoreFocus = false) {
    setOpen(false); setQuery(''); setActiveId(null); composing.current = false;
    if (restoreFocus) trigger.current?.focus();
  }
  function expand() {
    setQuery(''); setActiveId(selectedContactId); setOpen(true);
  }
  function choose(contactId: string) {
    if (unavailable || !contacts.some(contact => contact.contactId === contactId)) return;
    close(true);
    void onSelect(contactId);
  }
  useEffect(() => { close(); }, [scopeRevision, selectedContactId, unavailable]);
  useEffect(() => {
    if (!expanded) return;
    input.current?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) close();
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);
  useEffect(() => {
    if (expanded && active) document.getElementById(`${listId}-${active.contactId}`)?.scrollIntoView({ block: 'nearest' });
  }, [expanded, active?.contactId, listId]);

  function searchKey(event: KeyboardEvent<HTMLInputElement>) {
    // 中文输入法确认候选的 Enter 不能成为联系人选择。
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      const index = results.findIndex(contact => contact.contactId === activeId);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : results.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      setActiveId(results[next].contactId);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault(); choose(active.contactId);
    }
  }

  return <div className="contact-picker-container" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  }}>
    <button ref={trigger} type="button" className="contact-picker" role="combobox" aria-label="本次联系人"
      aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      data-contact-id={selectedContactId ?? ''} disabled={unavailable}
      onClick={() => expanded ? close() : expand()} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); expand(); }
        if (event.key === 'Escape') close();
      }}>
      <span>{selected?.displayName ?? '选择联系人'}</span><span aria-hidden="true">⌄</span>
    </button>
    {expanded && <div className="contact-picker-popup">
      <input ref={input} type="search" aria-label="搜索联系人" placeholder="搜索联系人" value={query}
        aria-controls={listId} aria-activedescendant={active ? `${listId}-${active.contactId}` : undefined}
        autoComplete="off" onChange={event => { setQuery(event.target.value); setActiveId(null); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={searchKey} />
      <div id={listId} role="listbox" aria-label="联系人搜索结果" className="contact-picker-results">
        {results.map(contact => <button key={contact.contactId} id={`${listId}-${contact.contactId}`}
          type="button" role="option" tabIndex={-1} aria-selected={selectedContactId === contact.contactId}
          data-contact-id={contact.contactId} data-active={activeId === contact.contactId}
          onPointerDown={event => event.preventDefault()} onClick={() => choose(contact.contactId)}>
          <span>{contact.displayName}</span>
          {(sameNames.get(contact.displayName)?.length ?? 0) > 1 &&
            <small>同名联系人 {(sameNames.get(contact.displayName)?.indexOf(contact.contactId) ?? 0) + 1} · {contact.messageCount} 条消息</small>}
          {selectedContactId === contact.contactId && <span className="contact-picker-check" aria-hidden="true">✓</span>}
        </button>)}
      </div>
      {results.length === 0 && <p className="contact-picker-empty" role="status">未找到联系人</p>}
    </div>}
  </div>;
}
