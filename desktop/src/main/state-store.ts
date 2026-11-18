/**
 * 主进程带 revision 的状态控制器基类：集中浅合并更新、revision 递增和同步通知。
 * 快照由子类覆盖 `getState()` 决定（深拷贝或浅拷贝）；需要在合并前后插入副作用、
 * 带事件类型或按字段过滤监听的控制器不继承本类。
 */
export abstract class StateStore<State extends { revision: number }> {
  protected state: State;
  private readonly listeners = new Set<(state: State) => void>();

  protected constructor(initial: State) { this.state = initial; }

  /** 返回给调用方的快照；默认浅拷贝，状态含嵌套可变数据时由子类覆盖为深拷贝。 */
  getState(): State { return { ...this.state }; }

  onStateChanged(listener: (state: State) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 浅合并 `update`，revision 加一，再向所有监听者同步派发各自独立的快照。 */
  protected publish(update: Partial<State>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    this.notify();
  }

  /** 整体替换状态（保留 revision 递增），用于每次都提供完整字段的控制器。 */
  protected replaceState(next: Omit<State, 'revision'>): void {
    this.state = { ...next, revision: this.state.revision + 1 } as State;
    this.notify();
  }

  protected clearListeners(): void { this.listeners.clear(); }

  private notify(): void {
    for (const listener of this.listeners) listener(this.getState());
  }
}
