export const outcomeMessages = {
  conflict: '资料已被其他操作修改，存在并发冲突。请重试读取后重新决定。',
  source_stale: '来源或范围已失效，已撤下原资料。请重试读取。',
  protected: '当前记忆受人工保护，请重试读取并核对；撤销前须先明确解除保护。',
  unavailable: '本次决定暂未确认，请重试读取当前状态后再操作。',
};
export const successMessages: Record<string, string> = {
  accept: '采纳成功，已形成正式版本。', edit_accept: '修改采纳成功，固定模型原稿保留。',
  reject: '已拒绝候选。', correct: '错误修正成功，旧版不再作为当前事实。',
  change: '变化已记录，旧版不再作为当前事实。', protect: '已开启当前人工保护。',
  unprotect: '已解除当前人工保护。', restore: '自动更新已撤销，已新增恢复版本。',
  withdraw: '已撤销首次自动采纳，内容不再作为当前事实。',
};

