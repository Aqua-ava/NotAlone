export interface DeepSeekConfiguration { baseUrl: string; apiKey: string }

/** 地址会进入受控配置文件；公开状态和跨进程请求共用无凭据、单行合同。 */
export function isAiServiceBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f"'\\]/u.test(value) || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return !value.slice(value.indexOf('://') + 3).split('/')[0].includes('@') && !url.username && !url.password && !url.search && !url.hash && !/[?#]/.test(value)
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

export function isDeepSeekConfiguration(value: unknown): value is DeepSeekConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 2 && isAiServiceBaseUrl(input.baseUrl)
    && typeof input.apiKey === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(input.apiKey);
}
