import {registry as management} from './registry.mjs';
import {registry as legacy} from '../history/legacy-scope-registry.mjs';
export const registry={...management,actions:[...management.actions,...legacy.actions.filter(action=>action.name==='fixture.seedLegacyScope')]};
