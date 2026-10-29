import type { PageTransport } from './transport';
import type { FixedMemoryProcessingBridge, FixedProcessingControl, FixedProcessingStart, FixedProcessingTraceRequest } from '../shared/fixed-memory-processing';

export function createFixedMemoryProcessingBridge(transport: PageTransport): FixedMemoryProcessingBridge {
  const fail = () => Promise.reject(new Error('记忆处理操作不可用。'));
  return Object.freeze({
    readMode: (...args: unknown[]) => args.length === 0 ? transport.invoke('memory:fixed-processing-mode') : fail(),
    readCurrent: (...args: unknown[]) => args.length === 0 ? transport.invoke('memory:fixed-processing-current') : fail(),
    start: (...args: [FixedProcessingStart]) => args.length === 1 ? transport.invoke('memory:fixed-processing-start', args[0]) : fail(),
    pause: (...args: [FixedProcessingControl]) => args.length === 1 ? transport.invoke('memory:fixed-processing-pause', args[0]) : fail(),
    continue: (...args: [FixedProcessingControl]) => args.length === 1 ? transport.invoke('memory:fixed-processing-continue', args[0]) : fail(),
    trace: (...args: [FixedProcessingTraceRequest]) => args.length === 1 ? transport.invoke('memory:fixed-processing-trace', args[0]) : fail(),
    release: (...args: unknown[]) => args.length === 0 ? transport.invoke('memory:fixed-processing-release') : fail(),
    onInvalidated: (listener: () => void) => {
      if (typeof listener !== 'function') throw new Error('记忆处理读取不可用。');
      const receive = () => listener();
      transport.on('memory:fixed-processing-invalidated', receive);
      return () => transport.removeListener('memory:fixed-processing-invalidated', receive);
    },
  });
}
