/**
 * 联系人删除期间后端会在计划提交后暂时关闭名单服务：联系人目录、授权目录与同步状态读取可能失败。
 * 读取方在窗口内仍照常尝试；失败时保留上一次成功状态，并把“窗口结束后的补读”登记到这里。
 * 窗口结束（最后一个窗口释放）时统一执行一次已登记的补读，再通知窗口结束监听者；
 * 补读失败保持旧状态，由读取方自己的有界重试或用户显式刷新收敛。
 * 窗口本身不阻塞或排队请求，只标记“现在读可能失败”，由读取方决定是否登记补读与静默重试。
 */
export class ContactDeletionQuiet {
  private active = 0;
  private readonly deferred = new Set<() => void>();
  private readonly settledListeners = new Set<() => void>();

  get deleting(): boolean {
    return this.active > 0;
  }

  /** 删除窗口内登记一次删除结束后的补读并返回 true；不在删除窗口时返回 false，由调用方照常读取。 */
  defer(read: () => void): boolean {
    if (this.active === 0) return false;
    this.deferred.add(read);
    return true;
  }

  /**
   * 订阅“删除窗口全部结束”事件；用于没有显式 dispose 的读取方在窗口结束后补读。
   * 监听者异常互相隔离，不影响其他读取方。
   */
  onSettled(listener: () => void): () => void {
    this.settledListeners.add(listener);
    return () => { this.settledListeners.delete(listener); };
  }

  /** 开始一次删除窗口；返回幂等的结束函数，最后一个窗口结束时执行补读并通知监听者。 */
  begin(): () => void {
    ++this.active;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (--this.active > 0) return;
      const reads = [...this.deferred];
      this.deferred.clear();
      for (const read of reads) {
        try { read(); } catch { /* 补读失败保持旧状态，等读取方自己重试或用户下次显式刷新。 */ }
      }
      const listeners = [...this.settledListeners];
      for (const listener of listeners) {
        try { listener(); } catch { /* 窗口结束补读异常隔离，不影响其他读取方。 */ }
      }
    };
  }
}
