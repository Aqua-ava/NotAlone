import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
// 让正式发布动作在全部确定性检查和诊断缓冲后回滚，验证没有伪造的晚图提示。
export const registry={...base,actions:base.actions.map(action=>action.name!=='media.publish'?action:{...action,execute(tx,input,lease){action.execute(tx,input,lease);throw new StorageFailure('synthetic_publish_rollback');}})};
