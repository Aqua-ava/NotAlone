import type { MemoryReadingController } from '../memory/controller';
import type { MemoryUpgradeController } from './controller';
import type { SourceDeletionController } from '../sources/controller';

// 生产窗口与有限页面共用同一资料删除接线。
export function observeMemoryUpgradeDeletion(
  memory: Pick<MemoryReadingController, 'onRecordDeletion'>,
  upgrades: MemoryUpgradeController,
  sources?: Pick<SourceDeletionController, 'onDeletion'>,
) {
  const stopMemory = memory.onRecordDeletion(phase => upgrades.recordDeletionChanged(phase));
  const stopSources = sources?.onDeletion(phase => upgrades.recordDeletionChanged(phase));
  return () => { stopMemory(); stopSources?.(); };
}
