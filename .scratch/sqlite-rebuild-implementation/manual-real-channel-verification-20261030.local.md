# 真实渠道人工验证指南（2026-10-30，本地协调稿，不发布）

用途：用户决定「真实渠道验证留待人工完成」，本指南给出最小人工步骤、固定测试内容、证据采集与回传方式。完成后回复我（"继续"），我会重新激活 Goal 并执行只读采集与验收。
禁止：由 Agent 发送/撤回任何消息；本指南中所有微信侧动作仅由用户本人执行。Agent 侧只做只读 metadata 观察与代码/文档更新。

## 0. 当前状态（验证前基线）

- 集成分支 `codex/sqlite-rebuild-integration` @ `b9a40d67`（110 本地提交，无 push/PR/打包）。
- 17 项有效范围：13 项 resolved（01、02、05、07、08、09、10、11、12、14、16、17、20）；**03/04/06/21 仍 claimed/受阻**；13/15/18/19 用户暂缓。
- 本轮未完成真实渠道的原因：03 真实普通历史/状态语义/来源生命周期/跨启动连续性未认证；正式安装 CLI 无 metadata/history 窄操作；开发制品为 ad-hoc（`realWechatVerified=false`），不能冒充正式支持档；04/06 同受此门槛；21 依赖 06。
- 桌面已清理：`dev:status = {"mode":"stopped","pids":[]}`，无残留进程/隔离根。

## 1. 票 03：真实状态语义（发送/撤回观察）——人工动作清单

固定测试对象：微信联系人 **ran**（不寻找其他联系人）。发送前请在微信界面核对目标会话名称。

固定文案（与票 03 一致，不得修改）：

- A：`NotAlone 只读验收 A：发送后保留。`
- B：`NotAlone 只读验收 B：发送后撤回。`

人工操作顺序（建议一次完成，全程约 2 分钟）：

1. 打开与 ran 的私聊，确认没有并发消息干扰。
2. 发送 A，**保留不撤回**；确认已在 ran 会话显示为已发送。
3. 发送 B，确认已发送；随后**仅撤回 B 一次**（微信「撤回」）。
4. 不重发、不删除其他消息、不修改账号/网络设置、不发送媒体、不联系其他对象。
5. 记录：操作时间点（时:分:秒）、A/B 是否显示已发送、B 撤回结果截图（端侧留存，不入库）。

风险与停止条件：若目标会话与预期不符、出现并发消息干扰、或撤回归属无法确认，立即停止并告知我，不重试、不扩读其他消息。

完成后告知格式（示例）：
`已对 ran 发送 A（08:30:12 保留）并发送 B（08:31:05）后仅撤回 B（08:31:40 成功）；无并发消息。`

Agent 后续动作（只读，不发送）：用 03 的受控只读制品对 ran 范围做 metadata-only 观察（状态值、server_id 补齐、来源键、撤回后行变化），据此认证真实状态语义并更新 03 证据；**不读取正文、不写普通 captures、不提升 normalHistory**。

## 2. 票 06：真实边界 observer/reader 协议——需要制品或授权

当前状态：代码/结构/隔离演练/05 代次/取消失效/跨重启回归均已完成；缺「真实 WCDB observer/reader 协议、分片/命名空间连续性、最终只读制品」。生产 `wechat-channel` 不实现 `boundarySnapshot`，真实清空只能 `boundary_pending`。

需要你提供其一：
- (a) 正式签名且含 metadata/history 窄操作的 CLI 制品（或明确开发制品可用于哪一层认证）；或
- (b) 授权我按锁定上游构建一个本地窄操作制品，并明确其认证层级（不会替换原用户组件/配置、不打包、不发布）。

拿到后我会：用完整分片只读连接实现 pre/post 采样与完整 manifest 原子接受的真实路径，补真实验收证据并更新 06。

## 3. 票 04：真实增量/重选/断线/非前台 CLI 同步

- 依赖同上 03 支持档认证与 06 真实边界；认证后可验证：真实增量续读、重选后新资格补齐、断线可见状态、微信不在前台时有效授权 CLI 同步。
- 受控 dev 已通过部分（开关/退出/取消/覆盖不足/资料与检查点保留）；真实部分待上述制品与授权。

## 4. 票 21：组合验收收口

- 已交付：17 项矩阵、四项暂缓（13/15/18/19）、组合实测（592/592 + H/I/J/K）、App 五项与跨重启修复闭环、缺口清单：`docs/verification/21-three-specs-integrated-acceptance.md`。
- 待 03/04/06 的真实证据齐备后，我会更新矩阵对应行并收口 21；若你选择「接受真实门槛本轮不通过」，则 21 以当前受阻矩阵收口。

## 5. 证据与回传

- 你只需回传：①人工动作事实（目标=ran、A/B 时间、B 仅撤回一次、无并发）；②若提供 CLI：制品路径/版本/签名与 metadata 说明；③任何异常（会话不符、撤回失败、并发消息）。
- 私人聊天截图、身份、凭据、媒体不要发进仓库；端侧留存即可。
- 我收到后会：重新激活 Goal → 只读采集/验收 → 更新 planning、票 Comments 与 batch 报告 → 再决定 21 与 Goal 状态。

## 6. 参考材料

- 任务索引：`planning.md`；票 03/04/06/21 文件与 Comments。
- 03 证据与缺口：`docs/verification/sqlite-private-history-support-03.md`（含所需授权、制品与预期原生证据）。
- 06 证据：`docs/verification/sqlite-clear-and-resync-06.md`。
- 21 矩阵：`docs/verification/21-three-specs-integrated-acceptance.md`。
- 批次报告：`batch-acceptance-20261030.local.md`。

## 7. 03 后续采集的前置事实与协调协议（2026-10-30 Round5 补充）

### 7.1 受控只读制品位置与身份（已在磁盘核对，存在）
- 开发窄操作 CLI（metadata-only）：
  `/Users/local-user/.codex/worktrees/bbec/NotAlone/.scratch/sqlite-history-cli/dev-schema-v11/bin/wechat-cli`
- manifest：同目录 `manifest.json`；`kind=notalone-history-cli-development`、`signing=ad-hoc-development`、`realWechatVerified=false`、`cliSha256=d555fdcedf100eba62e8dbc4dbcde50901b3f1b8198f6a6a44e62cfb66c26327`、`wcdbSha256=4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d`、`overlaySha256=35e8b4864182ed3b21fa601e1559e70a9aba99fc80b93be018cac33ed03d3f3c`。
- 该制品只能用于「开发/元数据观察」层级，不能冒充正式支持档；正式安装 CLI `d566d484…` 无 metadata 窄操作（调用即 `notalone_command_disabled` 退出 2）。
- 既有匿名证据：同目录 `anonymous-human-b-v11.json`（此前人类手动发送第二条一次、未撤回的受控状态观察）、`anonymous-account-port-evidence-v11.json` 等；可作为观察器用法与协议参考。

### 7.2 协调协议（关键：观察必须在动作之前布防）
状态语义（发送 pending→sent、撤回）必须在动作发生**时**观察。请按以下顺序：
1. 你确认目标会话为 **ran**，并告知我「准备开始」；
2. 我先用 v11 制品做只读核对：`metadata-account → inspect-account-schema → resolve(精确 ran) → inspect → support`，确认 8 分片/2 目标表结构与获准对象一致，然后建立新基线（arm，锁定数应为 0）；全程只读 metadata，不读正文/source/XML/媒体、不写普通 captures；
3. 布防后你执行人工动作（二选一，事先告诉我选哪种）：
   - (i) 完整序列：发送固定 A（保留）→ 发送固定 B → 仅撤回 B 一次；
   - (ii) 若此前 A/B 仍在且 B 未撤回：只在观察下撤回 B 一次（**不得撤回 A**，不重发）。
4. 我用 v11 的 next 观察在共同固定快照中捕获新增/变化行：仅投影 local/server 身份、原始 type/status、sender 类别、create_time、本地主键精确保留，并记录撤回后的行变化；不读正文；
5. 关闭观察器与子进程（残留检查），把匿名摘要写入 `docs/verification/sqlite-private-history-support-03.md` 与票 03 Comments；据此认证可获得的状态语义子集，其余仍标 unverified。

### 7.3 若你选择「先自己做完再告诉我」
可以，但只能观察事后状态：能确认当前行是否存在、原始 status 值、serverId 是否分配等，**不能认证动作间转移**（pending→sent→撤回的过程）；撤回若已完成且无布防，撤回语义只能保持 unverified。请据此选择是否需要在布防后执行。

### 7.4 Agent 侧待办（收到你消息后执行，不是现在）
- 只读核对 v11 制品字节与 manifest（sha256 对比）、确认目标为 ran；
- arm → 等你动作 → next 采集 → 关闭并清理；
- 更新 03 证据与票 Comments，再评估 03/04/06/21 状态（04/06 仍需正式制品或构建授权，见 §2）。

### 7.5 就绪性验证与驱动脚本（2026-10-30 Round6 补充，仅只读核对，未访问微信数据）
- 已在本机只读验证 v11 制品可执行与完整性（**未打开微信 DB、未读取任何消息**）：
  - `wechat-cli help` 与 `wechat-cli version` 正常返回（`version=2.0.1-rc.5`、`commit=795071f…`、`cliSha256=d555fdce…` 与 manifest 一致）；
  - `codesign --verify --strict` 退出 0；
  - 注意：该二进制含 upstream 完整命令面（history/tail/export 等），但后续观察**只使用** `NarrowWechatClient` 的窄操作（accountMetadata / resolveSelected / inspectSelected / supportSelected / observeTestMetadataSelected / targetSelected），不会调用任何正文读取命令。
- **观察驱动脚本（既有）**：`<bbec>/.scratch/sqlite-history-cli/observe-human-b.mjs`
  - 行为：读取 `dev-schema-v11/manifest.json` → 用 `NarrowWechatClient`（校验 cliSha256/wcdbSha256）→ `accountMetadata()` → `resolveSelected('ran')`（要求 displayName 精确为 `ran`，账号/来源代次一致）→ `inspectSelected()`/`supportSelected()` → 输出 `observer_open` 事件 → 从 stdin 读取控制动作：`arm`（建立新基线，lockedCount 应为 0）→ 你执行人工动作 → `next`（捕获新增/变化行，直到 lockedCount=1；出现 >1 直接失败为身份歧义）→ `close`；
  - 输出匿名证据：`records` 仅含 slot/present/sender/originalType/status/serverIdAssigned/localIdExact/identityStable/serverIdStable/normalHistory，**无正文、无 source/XML、无原始身份**（bodyRead:false、rawIdentitiesPersisted:false）；
  - 运行环境：Node v24.21.0（`/tmp/t09-node/bin/node`）、cwd = bbec 工作树根；
  - **关键注意**：脚本 `finally` 会写入 `.scratch/sqlite-history-cli/anonymous-human-b-v11.json`（覆盖既有 v11 证据）。执行前我会先把它复制为 `/tmp/observe-withdraw-YYYYMMDD.mjs` 并把输出名改为 `anonymous-human-b-v11-withdraw.json`，保留原证据不覆盖。
- 我收到你「准备开始」后的只读流程：核对二进制哈希/签名 → 复制驱动并把输出改名 → 启动驱动（等 `observer_open` 与 `arm` 完成、lockedCount=0）→ 通知你执行 → 你动作完成后我发 `next` 直到锁定唯一新行 → `close` → 关闭子进程与 reader、检查残留 → 把匿名摘要写入 03 验证文档与票 Comments。

### 7.6 驱动静态就绪性与预置动作（2026-10-30 Round7，未执行、未访问微信）
- 静态核对（只读）：`NarrowWechatClient` 所需方法均存在（`accountMetadata:402`、`resolveSelected:421`、`inspectSelected:433`、`observeTestMetadataSelected:455`、`supportSelected:489`、`targetSelected:505`、`close:622`）；CLI 调用方式为 `spawn(executable, ['notalone-history'], env=HOME/PATH/TMPDIR/LANG/LC_ALL, shell=false)`，经 stdin/stdout JSON envelope 通信；等待协议与驱动预期一致。
- 已预置（**仅为后续执行准备，未运行**）：`/tmp/observe-withdraw-dryrun.mjs` = 既有 `observe-human-b.mjs` 的副本，输出名已改为 `anonymous-human-b-v11-withdraw.json`，避免覆盖既有 v11 证据；`node --check` 通过。
- 你回复「准备开始」后我仍会：重新核对二进制哈希/签名 → 在 bbec 根目录用 `/tmp/t09-node/bin/node /tmp/observe-withdraw-dryrun.mjs v11` 启动（等 `observer_open` 与 `arm`）→ 通知你动作 → `next` 采集 → `close` → 检查 reader/子进程/应用无残留 → 更新 03 证据。
- 仍未执行任何微信数据访问；你的动作与观察时序需要你在线配合。
