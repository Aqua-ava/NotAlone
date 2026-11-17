import type {StorageTransaction} from './contracts.ts';

/** 旧采集序号可为空，继续沿时间与来源位置排序，不补造接受顺序。 */
export const captureAcceptanceOrder='capture.acceptance_no,capture.captured_at,capture.rowid,source.item_no,source.id';

/** 升级前已有资料的边界只记录序号，不复制正文；早期结构尚未登记边界。 */
export function memoryIncrementalBaseline(tx:StorageTransaction):bigint{
 if(!tx.get("SELECT 1 FROM pragma_table_info('database_instance') WHERE name='memory_incremental_baseline_display_no'"))return 0n;
 return tx.get('SELECT memory_incremental_baseline_display_no AS n FROM database_instance WHERE slot=1')?.n as bigint??0n;
}
/** 清空消息后仍跨过启用边界，避免真正的新消息被误归入待手动整理的旧资料。 */
export function nextMessageDisplayNo(tx:StorageTransaction):bigint{
 const current=tx.get('SELECT coalesce(max(display_no),0) AS n FROM message')!.n as bigint,baseline=memoryIncrementalBaseline(tx);
 return (current>baseline?current:baseline)+1n;
}
