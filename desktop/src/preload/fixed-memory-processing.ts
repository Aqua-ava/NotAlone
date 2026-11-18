import { pageInvokers, type PageTransport } from './transport';
import type { FixedMemoryProcessingBridge, FixedProcessingControl, FixedProcessingStart, FixedProcessingTraceRequest, FixedProcessingRead, FixedProcessingHistoryStart, FixedProcessingAutomaticSet } from '../shared/fixed-memory-processing';

export function createFixedMemoryProcessingBridge(transport: PageTransport): FixedMemoryProcessingBridge {
  const { empty, single, reject } = pageInvokers(transport, '记忆处理操作不可用。');
  return Object.freeze({
    readMode: (...args: unknown[]) => empty('memory:fixed-processing-mode', args),
    readAutomatic: (...args: unknown[]) => empty('memory:fixed-processing-automatic', args),
    setAutomatic: (...args: [FixedProcessingAutomaticSet]) => single('memory:fixed-processing-set-automatic', args),
    readCurrent: (...args: [FixedProcessingRead?]) => args.length <= 1 ? transport.invoke('memory:fixed-processing-current', ...args) : reject(),
    start: (...args: [FixedProcessingStart]) => single('memory:fixed-processing-start', args),
    startHistory: (...args: [FixedProcessingHistoryStart]) => single('memory:fixed-processing-history-start', args),
    pause: (...args: [FixedProcessingControl]) => single('memory:fixed-processing-pause', args),
    continue: (...args: [FixedProcessingControl]) => single('memory:fixed-processing-continue', args),
    abandonUnknown: (...args: [FixedProcessingControl]) => single('memory:fixed-processing-abandon-unknown', args),
    retryImages: (...args: [FixedProcessingControl]) => single('memory:fixed-processing-retry-images', args),
    trace: (...args: [FixedProcessingTraceRequest]) => single('memory:fixed-processing-trace', args),
    release: (...args: unknown[]) => empty('memory:fixed-processing-release', args),
    onInvalidated: (listener: () => void) => {
      if (typeof listener !== 'function') throw new Error('记忆处理读取不可用。');
      const receive = () => listener();
      transport.on('memory:fixed-processing-invalidated', receive);
      return () => transport.removeListener('memory:fixed-processing-invalidated', receive);
    },
  });
}
