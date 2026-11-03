import sharp from 'sharp';

export interface ContactAvatar { mime_type: 'image/png'; base64: string }
const maximumBytes = 256 * 1024;

/** 地址只来自已核验的单个微信联系人；不向渲染器暴露远程地址或请求凭据。 */
export async function fetchContactAvatar(address: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<ContactAvatar | null> {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || !['wx.qlogo.cn', 'thirdwx.qlogo.cn'].includes(url.hostname)
      || url.username || url.password || url.port || url.hash || address.length > 2048) return null;
    signal.throwIfAborted();
    const response = await request(url, { signal, redirect: 'error', credentials: 'omit',
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' } });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maximumBytes) {
      await response.body?.cancel(); return null;
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > maximumBytes) return null;
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    // 只解码位图，限制像素并重编码；不保留原图、动画或附加元数据。
    const decoder = sharp(bytes, { limitInputPixels: 4_000_000, failOn: 'error', page: 0, pages: 1 });
    if (!['png', 'jpeg', 'webp', 'gif'].includes((await decoder.metadata()).format ?? '')) return null;
    const image = await decoder.rotate().resize(96, 96, { fit: 'cover' }).png().toBuffer();
    signal.throwIfAborted();
    return image.length <= maximumBytes ? { mime_type: 'image/png', base64: image.toString('base64') } : null;
  } catch { return null; }
}
