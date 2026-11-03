import { useRef, type ReactNode } from 'react';

export function ContactChatToolbar({ children }: { children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  return <details ref={menu} className="contact-chat-options" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }} onKeyDown={event => {
    if (event.key === 'Escape' && menu.current?.open && !(event.target as HTMLElement).closest('dialog')) {
      menu.current.open = false; trigger.current?.focus(); event.stopPropagation();
    }
  }}>
    <summary ref={trigger} aria-label="聊天选项" title="聊天选项">⋯</summary>
    <div className="contact-chat-options-menu" role="group" aria-label="聊天操作">{children}</div>
  </details>;
}
