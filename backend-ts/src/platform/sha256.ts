import { createHash } from 'node:crypto';

/** 全仓唯一的一次性 sha256→hex 封装；传入 update() 的序列化方式由调用点保留，不改写任何已持久化摘要。 */
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
