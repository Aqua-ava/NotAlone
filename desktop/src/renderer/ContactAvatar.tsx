import { useEffect, useRef, useState } from 'react';
import type { ContactSessionBridge } from '../shared/contact-session-bridge';

const avatarRequests: { run: () => Promise<void> }[] = [];
const maxConcurrentAvatarReads = 4;
let activeAvatarReads = 0;

function drainAvatarRequests() {
  while (activeAvatarReads < maxConcurrentAvatarReads && avatarRequests.length) {
    const request = avatarRequests.shift()!;
    activeAvatarReads++;
    void request.run().catch(() => {}).finally(() => {
      activeAvatarReads--;
      drainAvatarRequests();
    });
  }
}

function enqueueAvatarRequest(run: () => Promise<void>) {
  const request = { run };
  avatarRequests.push(request);
  void drainAvatarRequests();
  return () => {
    const index = avatarRequests.indexOf(request);
    if (index !== -1) avatarRequests.splice(index, 1);
  };
}

export function ContactAvatar({ contactId, displayName, scopeRevision, bridge, refreshKey = 0, avatarRevision = '' }: {
  contactId: string; displayName: string; scopeRevision: number; bridge?: Pick<ContactSessionBridge, 'readAvatar'>; refreshKey?: number; avatarRevision?: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const latestScopeRevision = useRef(scopeRevision);
  latestScopeRevision.current = scopeRevision;
  const [image, setImage] = useState<{ scope: string; url: string }>();
  const loadedImage = useRef<typeof image>(undefined);
  const scope = `${contactId}:${avatarRevision}:${refreshKey}`;
  useEffect(() => {
    return () => {
      if (loadedImage.current) URL.revokeObjectURL(loadedImage.current.url);
      loadedImage.current = undefined;
    };
  }, [scope]);
  useEffect(() => {
    let cancelled = false, started = false, cancelQueued: (() => void) | undefined;
    if (!bridge?.readAvatar || loadedImage.current?.scope === scope) return;
    const load = async () => {
      if (started || cancelled || !bridge.readAvatar) return;
      started = true;
      try {
        const requestRevision = latestScopeRevision.current;
        const avatar = await bridge.readAvatar({ contactId, scopeRevision: requestRevision });
        if (cancelled || latestScopeRevision.current !== requestRevision || !avatar) return;
        const bytes = Uint8Array.from(atob(avatar.dataBase64), character => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: avatar.mimeType }));
        loadedImage.current = { scope, url };
        setImage(loadedImage.current);
      } catch { /* 无头像、来源不可用或范围失效时保留首字。 */ }
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        if (!cancelled && !cancelQueued) cancelQueued = enqueueAvatarRequest(load);
      }
    });
    if (element.current) observer.observe(element.current);
    return () => { cancelled = true; observer.disconnect(); cancelQueued?.(); };
  }, [contactId, scopeRevision, bridge, scope]);
  const visibleImage = image?.scope === scope ? image : undefined;
  return <span ref={element} className="contact-avatar" aria-hidden="true">
    {visibleImage ? <img src={visibleImage.url} alt="" onError={() => {
      if (loadedImage.current !== visibleImage) return;
      URL.revokeObjectURL(visibleImage.url); loadedImage.current = undefined; setImage(undefined);
    }} /> : Array.from(displayName)[0]}
  </span>;
}
