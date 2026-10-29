import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {verifiedExtractionOutput} from '../../../src/memory/sqlite/outputs.ts';
export const registry={...base,actions:[...base.actions,{name:'fixture.verifiedExtractionOutput',mode:'read',retryBusy:false,execute:verifiedExtractionOutput}]};
