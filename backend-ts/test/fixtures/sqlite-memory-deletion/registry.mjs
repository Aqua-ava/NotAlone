import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createDeletionActions} from '../../../src/storage/sqlite/deletion/actions.ts';
import {memoryExtractionDeletionRegistration} from '../memory-sqlite/registration.ts';

export const registry={...base,actions:[...base.actions.filter(a=>!a.name.startsWith('deletion.')),
  ...createDeletionActions(memoryExtractionDeletionRegistration())]};
