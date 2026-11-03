import {AsyncLocalStorage} from 'node:async_hooks';
import {StorageFailure,type StorageRegistry,type StorageTransaction,type StorageLease} from '../../../storage/sqlite/contracts.ts';
import type {ReplyKnowledgeReader} from './contracts.ts';
const readers=new AsyncLocalStorage<ReplyKnowledgeReader>();
/** 同一可信注册表为候选、讨论和运行副本装配相同读者；请求不能选择或降级验证器。 */
export function createReplyKnowledgeStorageRegistry(base:StorageRegistry,reader:ReplyKnowledgeReader):StorageRegistry {
 return {...base,actions:base.actions.map(action=>action.mode==='maintenance'?action:{...action,
  execute:(tx:StorageTransaction,input:unknown,lease:StorageLease)=>readers.getStore()?action.execute(tx,input,lease):readers.run(reader,()=>action.execute(tx,input,lease)),
 })};
}
export function currentReplyKnowledgeReader():ReplyKnowledgeReader {
 const reader=readers.getStore();if(!reader)throw new StorageFailure('reply_knowledge_unavailable');return reader;
}
