import {MemoryContentRegistry} from './registry.ts';
import {textMemoryContent} from './text.ts';
import {imageMemoryContent} from './image.ts';
/** 可信构建装配点；新增内容插件在此登记，处理主流程不按类型分支。 */
export const builtinMemoryContentPlugins=[textMemoryContent,imageMemoryContent] as const;
export function createBuiltinMemoryContentRegistry():MemoryContentRegistry {
 const registry=new MemoryContentRegistry();for(const plugin of builtinMemoryContentPlugins)registry.register(plugin);return registry;
}
