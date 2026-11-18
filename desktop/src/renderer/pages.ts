export const managerPages = {
  contacts: {
    title: '联系人', icon: 'contacts',
    description: '查看联系人的聊天记录，管理已保存的资料。',
  },
  skillLearning: {
    title: 'Skill', icon: 'memory',
    description: '管理已有 Skill，查看版本与启停状态。',
  },
  memory: {
    title: '记忆', icon: 'memory',
    description: '记住彼此的经历与偏好，让每次回应更贴近你们。',
  },
  sync: {
    title: '同步设置', icon: 'sync',
    description: '管理同步总开关和微信私聊范围，查看同步进度与需要处理的问题。',
  },
  config: {
    title: '设置', icon: 'config',
    description: '管理本人身份与模型服务，清楚知道每次生成使用的配置。',
  },
} as const;

export type ManagerPage = keyof typeof managerPages;
