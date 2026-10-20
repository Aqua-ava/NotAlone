import type { PageTransport } from './transport';
import type { SkillLearningBridge, SkillLearningState } from '../shared/skill-learning-bridge';

export function createSkillLearningBridge(transport: PageTransport): SkillLearningBridge {
  return Object.freeze({
    getState: (...args: unknown[]) => args.length ? Promise.reject(new Error('经验整理操作无效。')) : transport.invoke('skill-learning:get-state'),
    refresh: (...args: unknown[]) => transport.invoke('skill-learning:refresh', ...args),
    poll: (...args: unknown[]) => transport.invoke('skill-learning:poll', ...args),
    configure: (...args: unknown[]) => transport.invoke('skill-learning:configure', ...args),
    resume: (...args: unknown[]) => transport.invoke('skill-learning:resume', ...args),
    openReview: (...args: unknown[]) => transport.invoke('skill-learning:open-review', ...args),
    updateReview: (...args: unknown[]) => transport.invoke('skill-learning:update-review', ...args),
    saveReview: (...args: unknown[]) => transport.invoke('skill-learning:save-review', ...args),
    compareReview: (...args: unknown[]) => transport.invoke('skill-learning:compare-review', ...args),
    approveReview: (...args: unknown[]) => transport.invoke('skill-learning:approve-review', ...args),
    decideReview: (...args: unknown[]) => transport.invoke('skill-learning:decide-review', ...args),
    retryReview: (...args: unknown[]) => transport.invoke('skill-learning:retry-review', ...args),
    closeReview: (...args: unknown[]) => transport.invoke('skill-learning:close-review', ...args),
    openHistory: (...args: unknown[]) => transport.invoke('skill-learning:open-history', ...args),
    closeHistory: (...args: unknown[]) => transport.invoke('skill-learning:close-history', ...args),
    rollbackHistory: (...args: unknown[]) => transport.invoke('skill-learning:rollback-history', ...args),
    retryHistory: (...args: unknown[]) => transport.invoke('skill-learning:retry-history', ...args),
    openPolicies: (...args: unknown[]) => transport.invoke('skill-learning:open-policies', ...args),
    closePolicies: (...args: unknown[]) => transport.invoke('skill-learning:close-policies', ...args),
    changePolicy: (...args: unknown[]) => transport.invoke('skill-learning:change-policy', ...args),
    undoPolicy: (...args: unknown[]) => transport.invoke('skill-learning:undo-policy', ...args),
    retryPolicy: (...args: unknown[]) => transport.invoke('skill-learning:retry-policy', ...args),
    onStateChanged: (listener: (state: SkillLearningState) => void) => {
      if (typeof listener !== 'function') throw new Error('经验整理操作无效。');
      const receive = (_event: unknown, state: SkillLearningState) => listener(state);
      transport.on('skill-learning:state-changed', receive);
      return () => transport.removeListener('skill-learning:state-changed', receive);
    },
  });
}
