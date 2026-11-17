import { useState } from 'react';
import type { ContactSessionView } from './contact-session';
import { TracePanel, useTraceReading } from './TracePanel';

function ContactTraces({ session }: { session: ContactSessionView }) {
  const traces = useTraceReading(session);
  return <TracePanel traces={traces} />;
}

export function DeveloperTraces({ session }: { session: ContactSessionView }) {
  const [open, setOpen] = useState(false);
  const { selectedContactId, scopeRevision } = session.state;
  return <details className="startup-settings" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>开发者调试</summary>
    {open && <>
      <p>排查记忆提取与资料处理问题。这里只读取已保存的过程，不会重新提取或调用模型。</p>
      {selectedContactId ? <ContactTraces key={`${selectedContactId}:${scopeRevision}`} session={session} />
        : <p>请在顶部选择联系人，再查看其处理过程。</p>}
      {session.error && <p role="alert">{session.error}</p>}
    </>}
  </details>;
}
