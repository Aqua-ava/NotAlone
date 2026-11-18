import type { PageTransport } from './transport';
import type { SkillLibraryBridge } from '../shared/skill-library-bridge';

export function createSkillLearningBridge(transport: PageTransport): SkillLibraryBridge {
  return Object.freeze({
    readLibrary: (...args: unknown[]) => args.length ? Promise.reject(new Error('Skill 查询无效。')) : transport.invoke('skill-library:read'),
    changeLibraryEnabled: (...args: unknown[]) => transport.invoke('skill-library:enabled', ...args),
    readGroups: (...args: unknown[]) => args.length ? Promise.reject(new Error('分组查询无效。')) : transport.invoke('skill-library:groups-read'),
    createGroup: (...args: unknown[]) => transport.invoke('skill-library:group-create', ...args),
    updateGroup: (...args: unknown[]) => transport.invoke('skill-library:group-update', ...args),
    deleteGroup: (...args: unknown[]) => transport.invoke('skill-library:group-delete', ...args),
    assignContactGroup: (...args: unknown[]) => transport.invoke('skill-library:group-assign', ...args),
  });
}
