import type { MemoryReadingController } from '../memory/controller';
import type { ReplySession } from './session';

export function coordinateOwnerContextChanges(memory: Pick<MemoryReadingController, 'onOwnerContextChanged'>,
  replies: Pick<ReplySession, 'beginOwnerContextChange' | 'revalidateOwnerContextChange'>) {
  return memory.onOwnerContextChanged(phase => phase === 'started'
    ? replies.beginOwnerContextChange() : replies.revalidateOwnerContextChange());
}
