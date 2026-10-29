import type { MemoryReadingController } from '../memory/controller';
import type { ReplySession } from './session';
import type { SourceDeletionController } from '../sources/controller';

export function coordinateOwnerContextChanges(memory: Pick<MemoryReadingController, 'onOwnerContextChanged'>,
  replies: Pick<ReplySession, 'beginOwnerContextChange' | 'revalidateOwnerContextChange'>) {
  return memory.onOwnerContextChanged(phase => phase === 'started'
    ? replies.beginOwnerContextChange() : replies.revalidateOwnerContextChange());
}

/** 来源请求发出前即撤下讨论；回包未知也必须配对结算，不能借用本人资料事件。 */
export function coordinateSourceContextChanges(sources: Pick<SourceDeletionController, 'onDeletion'>,
  replies: Pick<ReplySession, 'beginOwnerContextChange' | 'revalidateOwnerContextChange'>) {
  return sources.onDeletion(phase => phase === 'started'
    ? replies.beginOwnerContextChange() : replies.revalidateOwnerContextChange());
}
