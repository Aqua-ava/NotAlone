import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';

/** 重试追加步骤并保留审计历史；当前结果取每种阶段的最新步骤，不能回退到旧成功。 */
export function currentDocumentSteps(tx:StorageTransaction,ownerId:string,taskId:string):StorageRow[]{
 return tx.all(`SELECT s.*,(SELECT a.error_code FROM step_attempt a WHERE a.owner_id=s.owner_id AND a.step_id=s.id ORDER BY a.attempt_no DESC LIMIT 1) AS error_code
  FROM processing_step s WHERE s.owner_id=? AND s.task_id=? AND s.kind IN ('document_scene','document_profile')
  AND NOT EXISTS(SELECT 1 FROM processing_step newer WHERE newer.owner_id=s.owner_id AND newer.task_id=s.task_id AND newer.kind=s.kind AND newer.step_no>s.step_no)
  ORDER BY s.step_no`,[ownerId,taskId]);
}

/** 最新成功不能盖过历史中仍在执行、未知或尚未结算的真实工作。 */
export function hasUnresolvedDocumentWork(tx:StorageTransaction,ownerId:string,taskId:string):boolean{
 return !!tx.get(`SELECT 1 FROM processing_step s WHERE s.owner_id=? AND s.task_id=? AND s.kind IN ('document_scene','document_profile')
  AND (s.state IN ('running','unknown')
   OR EXISTS(SELECT 1 FROM step_attempt a WHERE a.owner_id=s.owner_id AND a.step_id=s.id AND a.state IN ('running','unknown'))
   OR EXISTS(SELECT 1 FROM model_operation o LEFT JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id
    WHERE o.owner_id=s.owner_id AND o.memory_step_id=s.id
    AND (o.state IN ('prepared','in_flight','unknown') OR c.state IN ('prepared','sending','unknown') OR c.settlement_state IN ('reserved','unknown')))) LIMIT 1`,[ownerId,taskId]);
}
