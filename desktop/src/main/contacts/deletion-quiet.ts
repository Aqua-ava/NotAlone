/**
 * 联系人删除期间后端会整体关闭名单服务：联系人目录、授权目录与同步状态读取都会失败。
 * 与删除无关的读取在这个窗口内暂停，删除结束后由各读取方静默补读一次；补读失败保留上一次成功状态。
 * 窗口本身不阻塞或排队请求，只标记“现在读也读不到”，由读取方决定是否登记补读。
 */
export class ContactDeletionQuiet {
  private active = 0;
  private readonly deferred = new Set<() => void>();

  get deleting(): boolean {
    return this.active > 0;
  }

  /** 删除窗口内登记一次删除结束后的补读；不在删除窗口时返回 false，由调用方照常读取。 */
  defer(read: () => void): boolean {
    if (this.active === 0) return false;
    this.deferred.add(read);
    return true;
  }

  /** 开始一次删除窗口；返回幂等的结束函数，最后一个窗口结束时执行一次已登记的补读。 */
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
        try { read(); } catch { /* 补读失败保持旧状态，等用户下次显式刷新。 */ }
      }
    };
  }
}
