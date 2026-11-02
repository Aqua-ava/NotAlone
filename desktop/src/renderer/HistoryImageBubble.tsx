import { useLayoutEffect, useRef, useState } from 'react';
import type { ContactHistoryImageMedia } from '../shared/contact-history-bridge';
import type { MessageMediaBridge } from '../shared/media-bridge';

type Preview = { sessionId: string; url: string };
type Props = {
  media: MessageMediaBridge;
  imageMedia?: ContactHistoryImageMedia;
  selection: { contactId: string; messageId: string; scopeRevision: number };
};

function imageData(dataBase64: string, mimeType: string): Blob {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

export function HistoryImageBubble({ media, imageMedia, selection }: Props) {
  const state = imageMedia?.state ?? 'pending';
  const fileId = imageMedia?.fileId;
  const mimeType = imageMedia?.mimeType;
  const imageAvailable = state === 'original' || state === 'available';
  const container = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  const [visibleKey, setVisibleKey] = useState<string | null>(null);
  const visibilityKey = imageAvailable ? `${selection.contactId}:${selection.scopeRevision}:${selection.messageId}:${fileId}` : '';
  const visible = visibilityKey !== '' && visibleKey === visibilityKey;

  useLayoutEffect(() => {
    if (!imageAvailable) return;
    const target = container.current;
    if (!target || typeof IntersectionObserver === 'undefined') { setVisibleKey(visibilityKey); return; }
    const observer = new IntersectionObserver(entries => {
      const entry = entries.find(item => item.target === target);
      if (entry) setVisibleKey(entry.isIntersecting ? visibilityKey : null);
    }, { root: target.closest('.contact-chat-body'), rootMargin: '160px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [imageAvailable, state, selection.contactId, selection.messageId, selection.scopeRevision, fileId, visibilityKey]);

  useLayoutEffect(() => {
    setPreview(null);
    setFailed(false);
    if (!imageAvailable || !fileId || !mimeType || !visible) return;
    let active = true;
    const opening = { active: true, sessionId: null as string | null, url: null as string | null,
      revokedWhileOpening: new Set<string>() };
    const release = (sessionId: string) => { void media.releasePreview(sessionId).catch(() => {}); };
    const revoke = (sessionId: string) => {
      if (opening.sessionId !== sessionId) {
        if (opening.active) opening.revokedWhileOpening.add(sessionId);
        return;
      }
      opening.sessionId = null;
      opening.active = false;
      image.current?.removeAttribute('src');
      if (opening.url) URL.revokeObjectURL(opening.url);
      opening.url = null;
      setPreview(null);
      release(sessionId);
    };
    const unsubscribe = media.onPreviewRevoking(revoke);
    void media.openHistoryImagePreview({ ...selection, fileId, mimeType }).then((result) => {
      if (!active) { release(result.sessionId); return; }
      if (!/^[a-f0-9-]{36}$/i.test(result.sessionId)) throw new Error('预览资料无效。');
      if (result.mimeType !== mimeType) { release(result.sessionId); throw new Error('预览资料无效。'); }
      if (opening.revokedWhileOpening.has(result.sessionId)) { release(result.sessionId); return; }
      try {
        const url = URL.createObjectURL(imageData(result.dataBase64, mimeType));
        opening.sessionId = result.sessionId;
        opening.active = true;
        opening.url = url;
        setFailed(false);
        setPreview({ sessionId: result.sessionId, url });
      } catch (error) {
        release(result.sessionId);
        throw error;
      }
    }).catch(() => {
      if (active) setFailed(true);
    }).finally(() => {
      opening.active = false;
      opening.revokedWhileOpening.clear();
    });
    return () => {
      active = false;
      unsubscribe();
      const sessionId = opening.sessionId;
      opening.sessionId = null;
      image.current?.removeAttribute('src');
      if (opening.url) URL.revokeObjectURL(opening.url);
      opening.url = null;
      if (sessionId) setPreview(current => current?.sessionId === sessionId ? null : current);
      if (sessionId) release(sessionId);
    };
  }, [media, selection.contactId, selection.messageId, selection.scopeRevision, state, fileId, mimeType, visible, imageAvailable]);

  let status: string | null = null;
  if (state === 'thumbnail_only') status = '仅有缩略图，原图未取得';
  else if (state === 'unavailable') status = '图片资源不可用';
  else if (state === 'failed' || failed) status = '图片暂不可用';
  else if (state === 'cleared') status = '[图片已清除]';
  else if (!imageAvailable || !fileId || !mimeType || !visible || !preview) status = '图片加载中';
  return <div ref={container} className="contact-chat-image-container">
    {status ? <p className="contact-chat-image-status" role="status">{status}</p>
      : preview && <img ref={image} className="contact-chat-image" src={preview.url} alt="聊天图片" onError={() => {
        image.current?.removeAttribute('src');
        URL.revokeObjectURL(preview.url);
        setPreview(null);
        setFailed(true);
        void media.releasePreview(preview.sessionId).catch(() => {});
      }} />}
    {!status && preview && <span className="contact-chat-image-status">{imageMedia?.imageQuality==='thumbnail'?'缩略图'
      :imageMedia?.imageQuality==='original'||state==='original'?'原图':'图片版本未确认'}</span>}
  </div>;
}
