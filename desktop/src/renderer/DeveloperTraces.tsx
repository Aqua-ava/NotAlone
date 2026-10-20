import { useState } from 'react';
import type { ContactSessionView } from './contact-session';
import { TracePanel, useTraceReading } from './TracePanel';

function ContactTraces({ session }: { session: ContactSessionView }) {
  const traces = useTraceReading(session);
  return <TracePanel traces={traces} />;
}

export function DeveloperTraces({ session }: { session: ContactSessionView }) {
  const [open, setOpen] = useState(false);
  const { selectedContactId, scopeRevision, contacts } = session.state;
  return <details className="startup-settings" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>开发者调试</summary>
    {open && <>
      <p>排查记忆提取与资料处理问题。这里只读取已保存的过程，不会重新提取或调用模型。</p>
      <label>调试联系人 <select aria-label="调试联系人" value={selectedContactId ?? ''}
        disabled={contacts.length === 0} onChange={event => void session.selectContact(event.target.value)}>
        <option value="" disabled>选择要查看的联系人</option>
        {contacts.map(contact => <option key={contact.contactId} value={contact.contactId}>{contact.displayName}</option>)}
      </select></label>
      {selectedContactId ? <ContactTraces key={`${selectedContactId}:${scopeRevision}`} session={session} />
        : <p>先选择一位联系人，再查看其处理过程。</p>}
      {session.error && <p role="alert">{session.error}</p>}
    </>}
  </details>;
}
