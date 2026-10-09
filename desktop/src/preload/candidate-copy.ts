import type { CandidateCopyBridge } from '../shared/candidate-copy-bridge';
import type { PageTransport } from './transport';

export function createCandidateCopyBridge(transport: PageTransport): CandidateCopyBridge {
  return Object.freeze({ copy: (...args: unknown[]) => transport.invoke('candidate-copy:copy', ...args) });
}
