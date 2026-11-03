import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createMemoryContentStorageRegistry} from '../../../src/memory/content/storage.ts';
import {builtinMemoryContentPlugins} from '../../../src/memory/content/builtins.ts';
import {fileMemoryContent} from './file-plugin.mjs';
export const registry=createMemoryContentStorageRegistry(base,[...builtinMemoryContentPlugins,fileMemoryContent]);
