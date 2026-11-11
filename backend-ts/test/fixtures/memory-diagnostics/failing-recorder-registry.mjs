import {registry as base} from '../../../src/storage/sqlite/registry.ts';
// 在正式业务动作边界制造诊断接收器故障，不替换业务、来源或事务实现。
export const registry={...base,actions:base.actions.map(action=>action.mode==='maintenance'?action:{...action,execute(tx,input,lease){return action.execute({...tx,recordUnifiedDiagnostic(){throw new Error('synthetic_diagnostic_unavailable');}},input,lease);}})};
