# 同步报告采用当前历史决定

基线为 `a268f20603477dcc22e88f30f3c0688c88c58ff6`；只覆盖 `host-plugin.ts`、`wechat-scope-api.ts`、`legacy-backend.ts`，新增 `backend-ts/test/wechat-history-status-host.test.mjs`。已核对锁定 DSH `0.2.1-rc.2`／`687f282e8625c6b8d11ff58211a90524be2e4317` 的 `profile-boot.ts:283–345` 与 scope 生命周期，未修改官方核心。

## 问题与变更

用户拒绝历史后，PG 已保存 `declined/1`，但旧同步引擎的 60 秒展示缓存仍可能把 enable、status 等报告返回为 `required/null`。新用例在原版官方 profile 自然复现，无错误回执注入。

公开同步成功报告现在装配 TS 持有的 `sync_scope` 与三个历史决定字段；健康、进度、运行失败原因和总开关结果继续来自执行方。代理只在指定同步路由的 200 JSON 响应装配，输入上限 4 MiB，重算内容长度。非 200 错误、认证、授权门、断连排空合同保留；权威读取失败返回 503，不展示旧授权。

不改变用户决定、绑定、baseline、cursor，不新增正文读取、模型调用或发送能力。

## 根验证

- 固定基线加三份精确源码覆盖：专项官方 profile **2/2、0 skip**，约 10.7 秒；验证八个公开报告、范围变更、400/404、health、原 PG 决定及消息／历史授权均为零。
- 第二例真实锁住合成历史授权表、断开 disable 下游，再解锁、enable 并核对前台原 UUID；没有遗留权限门。
- 相关官方宿主与代理共 **16 个不同用例通过**：微信范围 5、前台宿主 4、代理 3、增量宿主 4；隔离全树 TS 检查 0。
- 首轮扩展验证夹具遗漏 desktop 源码，并从仓库根启动了要求 backend-ts 工作目录的旧测试，6 例初始化失败；补齐固定基线源码和正确工作目录后仅重跑这 6 例，全部通过，没有产品改动。
- 根按 Spec 独立复核 0；另一个 Agent 按 Standards 复核 0。三份产品源码及新测试在验证前后摘要一致，临时源码副本已清理。

可在干净 checkout 的 `backend-ts` 下执行：

```sh
node --test test/wechat-history-status-host.test.mjs
node --test test/wechat-scope-host.test.mjs test/foreground-location-host.test.mjs test/foreground-location-proxy.test.mjs test/sync-incremental-host.test.mjs
npm run typecheck
```

本轮使用随机 `_test` PG、合成账号与 CLI，未读取真实微信或业务库，未调用外部模型。

## 实际开发 App 复验

固定源码提交 `c9cc31cb`，复用干净隔离工作树，独立用户目录、合成 CLI，只运行 `npm run dev`。Computer Use 依次打开同步设置、点击「暂不读取」、立即开启同步、刷新、关闭同步：历史区始终显示「历史读取未开启」，首次询问及「暂不读取」按钮未再次出现。公开报告为 `declined/1/selected`，PG 决定相同；消息、历史授权、回复和外发调用均为零，baseline 未变。

随后正常退出，npm 与夹具均退出 0；独立核对测试库、夹具目录、合成范围目录、会话元数据均已移除，自有开发／孤儿实例为零，见[结构化证据](history-status-ui-evidence.json)。这是合成资料经过真实开发 App 的修复验收，真实原生 OCR 与真实新消息正向入库仍分别保留原有限制。
