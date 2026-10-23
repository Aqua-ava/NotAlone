# 07：验证开发态完整首用与恢复

Triage: ready-for-agent
State: open
Type: task
Blocked by: 02, 04, 05, 06
External blocked by: ../../authorized-private-history-sync/issues/08-real-wechat-acceptance.md
Spec: ../spec.md

## 交付行为

在开发App串联已实现部件，复用历史同步原票08真实验收，记录实际缺口。

## 入口与边界

现有desktop页面／App测试；authorized-private-history-sync/issues/08-real-wechat-acceptance.md。以仓库当前实现为准，定位后再修改。

## 验收条件

- [ ] 合成全链覆盖空目录到候选、两种范围、历史未完成门禁、不完整用户确认及后端警告。
- [ ] 模型与关系提取状态独立于消息覆盖；当前联系人优先且其他会话推进。
- [ ] 退出、关开关、撤销、重开恢复及删除不复活覆盖完整。
- [ ] 协调原历史票08负责人，引用其真实证据，不重复并发读取或篡改其状态；未完成则本票不能关闭。
- [ ] 实际App及微信由Computer Use主动验收，只读且不发送消息，结果与合成证据分开。

## 验证

先相关模块和页面，再复用npm run dev实例验收；真实模型调用只用明确配置与必要授权范围。

## 工作边界

当前只发布票据，未授权开始实现。开始后先核对最新代码与依赖，不重做已经完成的能力；参照[规格](../spec.md)。日常只用 `npm run dev`，先核验复用实例，不打包、不运行旧包、不发送外部消息。仅票09在另行明确发布授权后可进入安装验收。真实数据按已确认范围，提交不含私人资料；每票验证后只提交本票文件，不 push。

## Comments

2026-10-23：依据用户已确认方案发布，尚未执行。

## Answer

尚未执行；完成时记录实际变更、验证命令、结果、数据影响和未覆盖项。
