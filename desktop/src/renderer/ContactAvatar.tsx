import { useEffect, useRef, useState } from 'react';
import type { ContactSessionBridge } from '../shared/contact-session-bridge';

export function ContactAvatar({ contactId, displayName, scopeRevision, bridge, refreshKey = 0 }: {
  contactId: string; displayName: string; scopeRevision: number; bridge?: Pick<ContactSessionBridge, 'readAvatar'>; refreshKey?: number;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState<{ scope: string; url: string }>();
  const scope = `${scopeRevision}:${contactId}:${refreshKey}`;
  useEffect(() => {
    let cancelled = false, started = false, url: string | undefined;
    if (!bridge?.readAvatar) return;
    const load = async () => {
      if (started || cancelled || !bridge.readAvatar) return;
      started = true;
      try {
        const avatar = await bridge.readAvatar({ contactId, scopeRevision });
        if (cancelled || !avatar) return;
        const bytes = Uint8Array.from(atob(avatar.dataBase64), character => character.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: avatar.mimeType }));
        setImage({ scope, url });
      } catch { /* 无头像、来源不可用或范围失效时保留首字。 */ }
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); }
    });
    if (element.current) observer.observe(element.current);
    return () => { cancelled = true; observer.disconnect(); if (url) URL.revokeObjectURL(url); };
  }, [contactId, scopeRevision, bridge, scope]);
  const visibleImage = image?.scope === scope ? image : undefined;
  return <span ref={element} className="contact-avatar" aria-hidden="true">
    {visibleImage ? <img src={visibleImage.url} alt="" onError={() => {
      URL.revokeObjectURL(visibleImage.url); setImage(undefined);
    }} /> : Array.from(displayName)[0]}
  </span>;
}
