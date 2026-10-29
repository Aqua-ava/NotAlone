import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createMemoryKnowledgeReader} from '../../../src/memory/sqlite/management/knowledge.ts';
const reader=createMemoryKnowledgeReader({includeUnconfirmed:true});
export const registry={...base,actions:[...base.actions,
 {name:'fixture.memoryKnowledge',mode:'read',retryBusy:false,execute:reader.read},
 {name:'fixture.memoryRequireCurrent',mode:'read',retryBusy:false,execute(tx,input){reader.requireCurrent(tx,input.scope,input.item);return true;}},
]};
