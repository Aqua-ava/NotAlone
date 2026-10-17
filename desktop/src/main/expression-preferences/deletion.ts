import type { ReplySession } from '../reply/session';
import type { StyleSampleController } from '../style-samples/controller';
import type { TraceController } from '../traces/controller';

export function expressionPreferenceDeletion(traces: TraceController, replies: ReplySession,
  styleSamples: StyleSampleController) {
  return {
    started: () => {
      styleSamples.beginExpressionPreferenceDeletion();
      traces.recordDeletionChanged('started');
      replies.beginExpressionPreferenceDeletion();
    },
    settled: async () => {
      traces.recordDeletionChanged('settled');
      await Promise.all([replies.revalidateExpressionPreferences(), styleSamples.revalidateExpressionPreferences()]);
    },
  };
}
