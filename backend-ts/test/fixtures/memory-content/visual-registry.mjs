import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createBuiltinMemoryContentRegistry} from '../../../src/memory/content/builtins.ts';
import {withMemoryContentRegistry} from '../../../src/memory/sqlite/content.ts';
import {visualMemoryContent} from './visual-plugin.mjs';
const content=createBuiltinMemoryContentRegistry(),unload=content.register(visualMemoryContent);
export const registry={...base,actions:[...base.actions.map(action=>action.mode==='maintenance'?action:{...action,
 execute:(tx,input,lease)=>withMemoryContentRegistry(content,()=>action.execute(tx,input,lease)),
}),{name:'fixture.unloadVisualContent',mode:'write',execute(){unload();return true;}}]};
