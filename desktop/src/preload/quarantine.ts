import type { QuarantineBridge } from '../shared/quarantine-bridge';
import type { PageTransport } from './transport';

export function createQuarantineBridge(transport: PageTransport): QuarantineBridge {
  return Object.freeze({
    list: (...args: unknown[]) => args.length === 0 ? transport.invoke('quarantine:list')
      : Promise.reject(new Error('隔离历史操作不可用。')),
    open: (...args: [string]) => args.length === 1 ? transport.invoke('quarantine:open', args[0])
      : Promise.reject(new Error('隔离历史操作不可用。')),
  });
}
