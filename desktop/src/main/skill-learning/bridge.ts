import { noArguments, type PageCommands } from '../page-commands';
import type { BackendHost } from '../backend/host';
import { SkillLibraryController } from './library';

/** 仅装配当前 SQLite 库管理；学习、审核和发布不进入桌面操作面。 */
export function installSkillLearningBridge(commands: PageCommands, backend: BackendHost, onLibraryChange?: () => void) {
  const library = new SkillLibraryController(backend);
  commands.handle('skill-library:read', (...args) => { noArguments(args); return library.read(); }, 'manager');
  commands.handle('skill-library:verify', (...args) => { if (args.length !== 1) throw new Error('Skill 操作无效。'); onLibraryChange?.(); return library.verify(args[0]); }, 'manager');
  commands.handle('skill-library:enabled', (...args) => { if (args.length !== 1) throw new Error('Skill 操作无效。'); onLibraryChange?.(); return library.changeEnabled(args[0]); }, 'manager');
  commands.handle('skill-library:groups-read', (...args) => { noArguments(args); return library.readGroups(); }, 'manager');
  for (const [channel, method] of [['group-create', 'createGroup'], ['group-update', 'updateGroup'], ['group-delete', 'deleteGroup'], ['group-assign', 'assignContactGroup']] as const)
    commands.handle(`skill-library:${channel}`, (...args) => { if (args.length !== 1) throw new Error('分组操作无效。'); onLibraryChange?.(); return library[method](args[0]); }, 'manager');
  return library;
}
