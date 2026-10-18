import type { SkillLearningController } from './controller';
import type { MemoryReadingController } from '../memory/controller';
import type { ReplySession } from '../reply/session';
import type { SourceDeletionController } from '../sources/controller';
import type { StyleSampleController } from '../style-samples/controller';

export function coordinateSkillLearningSampleDeletion(learning: SkillLearningController,
  samples: Pick<StyleSampleController, 'onDeletion'>) {
  return samples.onDeletion(deletionPhases(learning));
}

export function coordinateSkillLearningSourceDeletion(learning: SkillLearningController,
  sources: Pick<SourceDeletionController, 'onDeletion'>) {
  return sources.onDeletion(deletionPhases(learning));
}

export function coordinateSkillLearningDeletion(learning: SkillLearningController,
  memory: Pick<MemoryReadingController, 'onRecordDeletion'>,
  replies: Pick<ReplySession, 'onStateChanged' | 'onSessionDeletion'>,
  preferences: { started(): void; settled(): Promise<void> }) {
  memory.onRecordDeletion(deletionPhases(learning));
  replies.onSessionDeletion(deletionPhases(learning));
  let sessionDeletionRevision = 0;
  replies.onStateChanged((state) => {
    const deleted = state.confirmedSessionDeletion;
    if (deleted && deleted.revision > sessionDeletionRevision) {
      learning.invalidate();
      sessionDeletionRevision = deleted.revision;
    }
  }, ['confirmedSessionDeletion']);
  const preferenceDeletions: Array<() => void> = [];
  return {
    started: () => { preferenceDeletions.push(learning.beginDeletion()); preferences.started(); },
    settled: async () => {
      const settled = preferenceDeletions.shift();
      try { await preferences.settled(); }
      finally { settled?.(); }
    },
  };
}

function deletionPhases(learning: SkillLearningController) {
  const pending: Array<() => void> = [];
  return (phase: 'started' | 'settled') => {
    if (phase === 'started') pending.push(learning.beginDeletion());
    else pending.shift()?.();
  };
}
