export const managerPages = {
  skillLearning: {
    title: 'Skill', icon: 'memory',
    description: '管理已有 Skill，查看版本与启停状态。',
    emptyTitle: '请先选择联系人', emptyDescription: '选择联系人后查看适用的 Skill 和待审核建议。', action: '选择联系人',
  },
  contacts: {
    title: '联系人', icon: 'contacts',
    description: '查看联系人的聊天记录，管理已保存的资料。',
    emptyTitle: '联系人暂不可用',
    emptyDescription: '连接完成后，这里会显示你的联系人与消息、来源摘要。',
    action: '选择联系人',
  },
  memory: {
    title: '记忆', icon: 'memory',
    description: '记住彼此的经历与偏好，让每次回应更贴近你们。',
    emptyTitle: '记忆暂不可用',
    emptyDescription: '连接并选择联系人后，可查看资料、来源和采纳状态。',
    action: '选择联系人',
  },
  sync: {
    title: '同步设置', icon: 'sync',
    description: '管理同步总开关、单个联系人的同步与微信私聊范围；遗漏消息会自动补齐。',
    emptyTitle: '同步尚未就绪',
    emptyDescription: '尚未连接，无法查询读取状态。连接完成后，由你确认会话范围。',
    action: '确认同步范围',
  },
  config: {
    title: '设置', icon: 'config',
    description: '管理本人身份与模型服务，清楚知道每次生成使用的配置。',
    emptyTitle: '配置状态暂不可用',
    emptyDescription: '连接完成后，可查看本人身份和模型服务的配置状态。',
    action: '配置本机服务',
  },
} as const;

export type ManagerPage = keyof typeof managerPages;
