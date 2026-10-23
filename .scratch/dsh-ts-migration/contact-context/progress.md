# 04 联系人上下文迁移

状态：实现中，尚未验收完成。基点 `9f39d6c2`，业务基线 `3c168296e9e8edaa43b8b323ff693e790e709069`；独立合同审计已消费，不修改审计文件。

## 固定官方依据

DSH `0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`。实际查阅锁定导出的官方源码、CLI文档及minimal示例：

- [CLI公开启动/profile](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/README.md)：继续03的官方命名profile，不直接新建Context替换启动器。
- [profile-boot](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/profile-boot.ts)：44—64行ready通知；283—345行清理及boot完成后commit。业务先完成原结构与功能移交，再发布认证握手；框架ready不替代业务资格。
- [minimal示例](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/cordis.patch.yml)：示例含日志上传、通用Shell和JSONL持久化，本票不增加这些服务或替换已锁定产品profile。
- 联系人SQL/DTO无直接DSH接口，普通TS业务模块由既有薄host插件装配；不新增模型工具，不以DSH session推断业务身份。node-postgres继续03已锁定8.16.3及原连接适配。

## 已确认范围

目录、消息、来源列表、关系概览及其投影写入、手动输入确认。回复证据、记忆修正、L2/L3生成、同步授权和删除执行仍由原具名业务实现负责。概览读取的动态证据验证是保留原返回合同所必需，不是提前迁移这些写流程。

原错误差异明确记录：未知/跨owner来源请求原为200空数组；合法但跨联系人的消息游标原为500。本票以404 contact_not_found、400 invalid_message_query区分身份/查询错误和合法空结果。无微信绑定不阻止用户查看已存手动资料；授权状态改变使捕获中的读取失效并要求重读。

## 实施及验证记录

- 开工 `npm run dev:status`：stopped、pids=[]。固定Node24，现有Conda npm；未读真实.env、真实数据库或微信。
- TDD公开HTTP：未知来源范围200→404失败后通过；消息读取未迁移404→保留原UUID/微秒/分页通过；公开旧start控制200→404失败后通过，显式来回切换保留原ID与修改；手动确认404→成功且不建渠道身份通过。
- Python门：具名停收/在途计数/排空/异常收尾，相关server单元136/136通过。此结果本身不证明PG投影和租约验收。
- 桌面：显式授权变化前后递增scopeRevision，保留人工选择及草稿；控制器27/27与类型检查通过。实际App验收待运行。
- 概览非空兼容、后端授权/删除在途复验、PG移交/回退、实际App及双轴审查仍在推进；不得据此标记resolved。
