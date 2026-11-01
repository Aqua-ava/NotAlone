# 首次连接后的联系人选择验证

日期：2026-11-01。决定见 [ADR-142](../../architecture/adr/142-first-connection-contact-selection.md)。本轮仅调整桌面首用与联系人选择，不更改数据库结构、微信读取算法、资料删除或模型接口。

- 账号确认只提交 `selected`、`historyAuthorized: false`，完成本次连接后直接进入联系人选择并读取一次已同意的会话名单；普通已连接状态不触发引导。
- 搜索、多选、查看已选及 50 项分页保留有效勾选。勾选默认对应已知稳定身份或明确展示的新建选项，最终确认仍复验原名单代次与实际渠道身份。
- 首次确认携带 `startSync: true` 和所选历史授权，先保存绑定，再开启同步。旧调用及后续添加保持当前总开关；绑定失败、旧连接或换代不启动同步。
- 开启失败保留联系人，状态刷新也失败时仍显示「联系人已添加」及同步设置入口。

## 自动检查

在 `desktop/` 执行，使用 Node.js 24 和本机 Chrome，无真实微信、模型或业务资料夹具：

```sh
pnpm run typecheck
node --test tests/binding-startup.test.mjs tests/sync-scope.test.mjs tests/sync-status-recovery.test.mjs tests/wechat-setup.test.mjs
NOTALONE_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/wechat-setup-view.test.mjs
NOTALONE_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/contact-selection-view.test.mjs
NOTALONE_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/sync-scope-view.test.mjs
```

类型检查通过；控制器相关 60 项、首用页面 16 项、选择页 3 项、同步范围页面 10 项，共 89 项通过。合成首用页面覆盖连接成功后的跳转、一次名单读取、确认前不授权、最终确认载荷。独立边界核查发现的失败提示隐藏问题已修复，并用旧位置的内存反例验证回归能够拦截。

## 桌面操作与边界

复用 `pnpm run dev` 实例。既有实例曾停在停读未获确认，点击正常恢复入口后由监督器完成重载，未强杀或启动第二份。真实 App 中打开添加入口、明确读取名单、勾选一项、搜索无结果、核对勾选保留、查看已选、清空并返回；随后核对微信窗口并恢复 App 现场。界面和合成首用样式截图已检查，无新增私人授权、账号迁移、聊天正文测试读取、外部模型请求或消息发送；未运行打包版。

真实全新账号的重新连接，以及新增真实授权后的首次历史读取与去重未重跑；本轮首用完整操作由合成页面及控制器分别验证，不宣称干净机器接入或渠道全闭环验收完成。正常开发资源目录前后均约 3.8 MiB，无独立 App 副本或新增依赖；测试临时编译目录自动清理，合成截图与日志留在仓库外。
