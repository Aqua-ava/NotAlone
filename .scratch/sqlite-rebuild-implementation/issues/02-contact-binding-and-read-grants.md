# 02：联系人绑定与同步授权

Triage: ready-for-agent
State: resolved
Type: task
Parent: [同步与记忆规格](../../sync-memory-behavior/spec.md)；[SQLite 数据库重建规格](../../sqlite-database-rebuild/spec.md)
Blocked by: [01 SQLite 基础与生命周期](01-sqlite-runtime-lifecycle.md)

> 2026-10-29已批准发布，现由本执行会话认领实现。[任务索引与共同约定](../planning.md)。

## 交付行为

在现有联系人和同步界面中核验当前账号与真实渠道身份，逐人保存选择及读取授权；取消、重选或会话改名时保持可解释的身份和资格，不扩大范围。

## 验收条件

- [x] 联系人只由可验证渠道来源建立并关联稳定内部身份；owner、contact、账号、会话和绑定分层，所有联系人数据信息按owner_id+contact_id隔离，昵称/备注仅展示。
- [x] 复用现有界面和已有可用微信组件；必要列表访问须取得同意，仅处理所需元数据并丢弃夹带摘要，不提前读取正文、媒体或保存全部私聊授权。
- [x] 新空SQLite重新核验身份和逐人授权，列表不预选，新私聊不自动纳入；旧PG授权及全部私聊范围不迁入；schema有all_private字段不表示启用该范围。
- [x] 同一已核验私聊取消后重选沿用原binding身份，创建新的授权记录和选择代次；旧请求不因重新勾选自动恢复提交资格，旧清空排除也不解除。
- [x] 取消某人立即撤销该人的新读取、记忆处理及本地媒体转换资格，但不因取消本身删除合法保存资料；提交时再验账号、联系人、绑定、授权与当前代次。
- [x] 重名、改名、账号切换、低置信度、稳定身份冲突或来源不连续时明确要求确认或拒绝，不凭名字、内容相似度或旧缓存猜测合并。
- [x] 前台定位/本次回复确认与后台读取授权分别保存；manual_confirmation不创建联系人、不验证外部会话，也不授予新微信读取。
- [x] 重复确认与并发勾选幂等，冲突有明确可重读状态；界面、持久记录和后台资格一致，重开不扩大已确认范围。
- [x] 隔离合成验证同名不同身份、跨owner/contact、取消/重选和旧结果迟到；真实账号或联系人证据未核验时不得读取对应正文。
- [x] 实施时明确处理ADR-089/095与本轮逐人选择目标的适用范围，保留真实来源、账号隔离和删除排除，不把首用流程搁置理解为取消同步授权。

## 验证与证据

通过联系人选择/授权的业务服务、认证接口和现有页面操作验证，不只断言表行；在合成渠道边界替换元数据，记录与真实渠道差异。必要真实身份检查只在既有有效授权范围进行。

依据[统一数据库设计](../../sqlite-database-rebuild/greenfield-design.md)和父规格实施；历史研究票、骨架或已知合成探针不能标为本票已完成。真实门槛见[定稿验证记录](../../../research/wechat-spec-finalization-validation.md)。

## 范围与执行门禁

仅承接同步本身的身份和授权；不新增首次使用引导、组件安装或新模型设置。当前无法核验的真实账号/范围保持不可用，不能因测试需要默认授权。

本票现已按下方 Answer 完成实施。`ready-for-agent`表示任务描述可供后续安排，不能据此自动领取、改代码、建业务库、读取微信或发起模型调用；须在用户后续明确要求实现时才开始并将State改为claimed。

后续开发及桌面验收只用`pnpm run dev`，先`dev:status`核验并复用热更新实例；不得自行打包、运行打包版、改发布门禁、push或创建PR。只处理必要的合成或已获准资料，不提交私人聊天、身份、凭据、截图或真实媒体。App首次使用继续搁置，迁移／恢复实验不纳入本轮。


## Answer

2026-10-29 完成实施 02。开工前 `pwd/git status` 核对独立工作树干净，`git merge-base --is-ancestor f4cd6888b3103bdb91bf51f9d8ee2323ced51f41 HEAD` 为0；只处理本票，未改统一任务索引。真实账号支持档未认证时按验收条件保持对应读取不可用，不将此拒绝路径写成真实微信正常同步通过。

- `backend-ts/src/contacts/sqlite/` 建立 owner/contact/account/conversation/binding/verification/grant/manual_confirmation，复合FK、不可变证明、不可重开grant、条件唯一索引及具名短事务共同守范围；昵称只展示，新库不导入PG身份或授权，默认selected且不预选。
- 元数据端口为唯一外部替换边界，名单先明确同意、丢弃夹带字段；确认复验账号和名单，使用用户勾选时的快照及代次。取消立即撤grant、推进选择代次；重选保留binding并新建许可，账号变化、改名、低置信、重复身份、来源不连续或名单失败先封禁旧资格。
- `assertReadEligibility(tx,token)` 供下游接受写入的同一事务核验开关、owner/contact/account/binding/grant/verification及各自代次。手动归属确认通过既有认证路由独立保存，不建联系人或微信授权。
- `identityDeletionAuthority/identityDeletionDomain` 提供真实身份fence及身份证明/名称清理，保留稳定最小控制墓碑；账号删除状态阻止重连绕过。只支持account/contact/source/contact_history，讨论/媒体范围明确拒绝。更高单调代次仍证明旧writer失效，旧history清理只清旧确认，不误删新确认；不声明完整跨域删除通过，05/20仍须注册全部引用域与存储面。
- 显式开发配置capabilities只开放联系人，沿原 `launchDsh` 和官方最小profile加载薄插件；严格Bearer/无Origin，未实现业务503。默认PG未切换；UI按identity_protocol区分旧PG和新SQLite，SQLite不提供全部私聊或跳过首次历史入口，正文未开放始终可见。ADR-110局部修订ADR-089/095本轮范围，保留来源、账号隔离、删除排除和人工发送。

实际验证：

1. TDD按业务服务、存储约束及认证HTTP边界逐切片推进。模块缺失、确认前改名、跨账号身份混用、低置信旧令牌、来源换代、错误私聊类型、旧清理被更高代次阻断、停读响应合同均有实际red后修复green。`cd backend-ts && node --test test/sqlite-contact-binding.test.mjs test/sqlite-host-launch.test.mjs`：20/20（身份18，正式DSH profile2）；`pnpm typecheck`通过。
2. `cd backend-ts && ELECTRON_RUN_AS_NODE=1 ../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test test/sqlite-contact-binding.test.mjs`：18/18。Node命令v24.19.0；实际开发Electron44.7.0/Node24.21.0/SQLite3.53.4。隔离fixture扩展仅注入合成渠道和故障写者，不替换业务服务/HTTP/SQLite；完整性与FK通过。
3. `cd desktop && node --test tests/binding-startup.test.mjs tests/sqlite-development.test.mjs tests/startup-schema-guard.test.mjs`：32/32；`NOTALONE_TEST_CHROMIUM_PATH=<本机已安装Chrome> node --test tests/wechat-setup-view.test.mjs tests/sync-scope-view.test.mjs`：20/20；`pnpm typecheck`通过。首次未指定Chrome时因无Playwright浏览器缓存失败，采用已安装Chrome后对应两文件通过，未下载额外浏览器。旧host-launch的5个无PG合成寿命/失败用例另通过5/5。
4. DSH声明/锁/安装为0.2.1-rc.2，Cordis4.0.5；逐符号核对固定官方687f282的profile.ts:1-21、cmdline/index.ts:35-88和123-144及安装制品exports/lib/types。复用appReady/appExit/exitOnStdinEnd/ctx.effect官方生命周期；未做整个制品的可复现构建对应证明。
5. 删除authority/domain与05真实结构接口做独立TypeScript赋值检查通过；未运行未集成的删除服务，也未把身份域清理当成全域闭包。组合迁移使用真实registry，测试不固定整库版本；01基础夹具动态版本适配由集成负责人/05处理，本票未重复修改。
6. 仅用 `pnpm run dev --user-data-dir <独立合成根>`。Computer Use实际操作添加联系人、明确刷新名单、同步设置检测；最终空库已连接、显示联系人存储就绪、选择0、确认禁用、总开关关闭。实际微信已指定对象窗口可见，但名称不能认证稳定账号/来源；App保持未认证渠道不可用，没有CLI名单/正文/媒体读取、联系人真实授权或发送/撤回。真实渠道正向绑定和同步未认证，合成及页面结果不替代该认证。初次实际热重启发现shutdown返回stopping，与桌面要求stopped冲突，修复后正常热重启及最终菜单退出通过。开发中旧合成迁移摘要变化明确显示migration_drift且保留现场；最终用新的独立空根复验正常路径。
7. code-review Standards与Spec独立并行审查；发现的PG文案误报、名单异常旧资格、来源换代、私聊类型冲突、UI旧active、手动确认路由、旧清理误伤新确认及删除名称回填均已补反例并修复。差异空白检查通过。提交后公开历史检查与最终提交哈希在执行回报记录。

数据影响与收尾：仅创建/清理隔离合成库及开发资料；未连接PG、未读取用户微信正文或媒体、未调用模型、未外发消息、未改私人配置、未打包或操作远端。两处自有临时根核验无进程引用后清理，合计约30.3MiB；最终dev:status为stopped、自有宿主与监督器已退出，微信及其他实例未关闭。依赖使用锁定离线缓存安装，开发依赖保留供复用。

下游合同以 `backend-ts/src/contacts/sqlite/README.md`、contracts.ts、actions.ts和deletion.ts为准。公共接线：storage/sqlite/registry.ts仅添加identityMigration(version)/identityActions；launch.ts、profile/sqlite.patch.yml、sqlite-host-plugin.ts、desktop startup/transport为共用开发装配。集成按实际顺序分配追加版本，已集成SQL不可改；05/20组合identity删除注册及requiredDomains，其他业务路由与权限仍须各票独立提供。owner/contact当前发布指针为空，文档发布域接入时须添加同范围约束后才能写非空值。默认业务正式切换及完整渠道/删除端到端由20/21复核，首用/安装/新模型/迁移恢复继续搁置。
