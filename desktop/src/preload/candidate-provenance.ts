import type { PageTransport } from './transport';
import type { CandidateProvenanceBridge } from '../shared/candidate-provenance-bridge';
export function createCandidateProvenanceBridge(transport: PageTransport): CandidateProvenanceBridge {
  return Object.freeze({
    noteCandidateCopy: (...args: unknown[]) => transport.invoke('candidate-provenance:note-copy', ...args),
    validateCandidatePaste: (...args: unknown[]) => transport.invoke('candidate-provenance:validate-paste', ...args),
  });
}
