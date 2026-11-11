import {sourceEligibility,eligibleReferences,type SourceEligibility} from './source.ts';
import {savedSourceScopeCTE} from './current-scope.ts';
/** 已保存回复资料：核对归属、接纳范围、删除、隔离和真实围栏，不读取微信或复活未知旧证明。 */
export const assertReplyLocalSources=sourceEligibility(savedSourceScopeCTE);
export const assertReplyLocalSource:SourceEligibility=(tx,ref)=>assertReplyLocalSources(tx,[ref]);

/** 与逐条本地断言使用同一保存范围，只保留本批仍合法的来源。 */
export const eligibleReplyLocalSourceReferences=eligibleReferences(savedSourceScopeCTE);
