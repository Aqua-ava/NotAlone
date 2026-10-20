import type { ReplySession } from '../reply/session';
import type { CandidateProvenanceController } from '../candidate-provenance/controller';
import type { TraceController } from '../traces/controller';

export function expressionPreferenceDeletion(traces: TraceController, replies: ReplySession,
  provenance?: Pick<CandidateProvenanceController, 'invalidateSource'>) {
  return {
    started: () => {
      provenance?.invalidateSource();
      traces.recordDeletionChanged('started');
      replies.beginExpressionPreferenceDeletion();
    },
    settled: async () => {
      traces.recordDeletionChanged('settled');
      await replies.revalidateExpressionPreferences();
    },
  };
}
