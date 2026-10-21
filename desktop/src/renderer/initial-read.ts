// 首帧状态读取的唯一入口：失败必须写入可见错误状态并可重试。
// 清理、取消、卸载等路径由调用方保持静默，不经过这里。

export const initialReadError = '状态读取失败，请重试。';

export type InitialReadResult = 'received' | 'failed' | 'inactive' | 'busy';

export type InitialReadOptions<State> = {
  read: () => Promise<State>;
  receive: (state: State) => void;
  reportError: (message: string) => void;
  isActive: () => boolean;
  busy: { current: boolean };
};

export function readInitialState<State>({ read, receive, reportError, isActive, busy }: InitialReadOptions<State>): Promise<InitialReadResult> {
  if (busy.current) return Promise.resolve('busy');
  busy.current = true;
  return read().then(
    (state) => {
      if (!isActive()) return 'inactive';
      // 读取成功即恢复：重试后不把旧的首帧错误留在界面上。
      reportError('');
      receive(state);
      return 'received';
    },
    () => {
      if (!isActive()) return 'inactive';
      reportError(initialReadError);
      return 'failed';
    },
  ).finally(() => { busy.current = false; });
}
