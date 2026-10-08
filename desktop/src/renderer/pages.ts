export const managerPages = {
  contacts: {
    title: '联系人与绑定', icon: 'contacts',
    description: '先确认联系人与会话的对应关系，再决定哪些会话可以同步。',
    emptyTitle: '联系人暂不可用',
    emptyDescription: '连接完成后，这里会显示你的联系人与已确认绑定。',
    action: '添加联系人',
  },
  import: {
    title: '历史导入', icon: 'import',
    description: '每次导入仅归属于一位联系人，确认预览后才会保存。',
    emptyTitle: '请先连接本机服务',
    emptyDescription: '连接完成后，选择一份单联系人历史文件并核对资料范围。',
    action: '选择历史文件',
  },
  memory: {
    title: '关系资料', icon: 'memory',
    description: '查看、修正和删除关系记忆，让每一份资料都有清楚的来源。',
    emptyTitle: '关系资料暂不可用',
    emptyDescription: '连接并选择联系人后，可查看资料、来源和采纳状态。',
    action: '选择联系人',
  },
  sync: {
    title: '同步设置', icon: 'sync',
    description: '后台文字同步与前台会话定位分别显示，只处理你已确认的范围。',
    emptyTitle: '同步尚未就绪',
    emptyDescription: '尚未连接，无法查询读取状态。连接完成后，由你确认会话范围。',
    action: '确认同步范围',
  },
  config: {
    title: '应用配置', icon: 'config',
    description: '管理本人身份与模型服务，清楚知道每次生成使用的配置。',
    emptyTitle: '配置状态暂不可用',
    emptyDescription: '连接完成后，可查看本人身份和模型服务的配置状态。',
    action: '配置本机服务',
  },
} as const;

export type ManagerPage = keyof typeof managerPages;
