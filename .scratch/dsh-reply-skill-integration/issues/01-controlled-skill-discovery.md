# 01: 受控发现与读取回复 Skill

Triage: ready-for-agent
State: resolved

**规格：** [DSH 回复 Skill 接入规格](../spec.md)

**Blocked by:** None（可立即开始）

## 要实现的行为

应用通过管理刷新和每轮回复前的检查，在授权范围内自动发现新 Skill；不提供手动添加或目录/安装路径输入。用户启用后，该 Skill 才能提供给回复流程。应用更新已有 Skill 时自动进行技术校验，保留用户的启停决定，不要求用户编辑文件或逐次确认。优先将 DSH 官方文件系统 Skill provider 与受控文件服务组合；若不能证明其满足范围和安全条件，则保留必要的业务受控读取，不能扩大读取权限。

本任务通过现有 Skill 管理入口和正式 DSH profile 验证，保持当前回复行为可用。自动学习和学习草稿审核不在范围内。

## 验收标准

- [x] 新包可以通过授权范围内的自动刷新发现并显示，无需手动添加或填写路径，只有用户启用后才能进入可用目录；发现名称与读取未启用正文是不同动作，未关联／未启用的正文不会在扫描时被读取。
- [x] 应用更新已关联 Skill 时自动完成格式、来源、完整性和版本核验；原来停用的 Skill 保持停用。无效、缺失或来源失效的内容不可加载，也不能通过重新发现恢复已删除或撤销的内容。
- [x] 读取前限制目录枚举、路径解析、元数据及正文读取范围；拒绝目录和文件符号链接、目录外路径与路径遍历。文件被替换或在读取期间变化时，不把未核验内容作为当前版本返回。
- [x] 使用公开的 DSH 扩展点；若使用自定义 `ctx.fs`，禁止服务缺失后的 Node fallback 与绕过控制的 bundled 根，验证 watcher 接触范围和生命周期，或明确关闭并提供安全的变更处理。
- [x] 账号与已确认联系人资格、有效修订、启停、来源和取消均由业务边界控制；实际返回内容与修订绑定，不能仅通过前后状态相同认定中间读取正确。
- [x] 使用正式 profile 和隔离合成数据验证发现、启用、更新、停用和安全读取；覆盖目录替换、文件替换、服务缺失、未经授权正文未被读取、不同账号／联系人及迟到结果。记录实际启用的官方插件及任何测试替身。
- [x] 受影响的现行规格和 ADR 按仓库规则收敛新包启用与应用更新决定；不改变自动学习审核、私人原目录的删除边界或人工发送原则。



## Answer

2026-10-31 已完成受控发现、启用核验和应用技术更新，实现与合成验证由当前集成分支保留；最终实际 App 验收和整组独立审查由主 Agent 收尾后追加。

- 内部 `SqliteSkillLibrary.discover` 仅供自动刷新登记授权根的目录名/身份，unknown/pending、无正文读取；`refresh`/`inspect` 自动发现直接子目录并只核验已启用包。停用/未知只查目录身份，明确 enable/verify 才核验内容，保留启停与来源撤销，旧修订不因相同字节复活。
- 新增固定用途 `native/skill-read` + `SecureSkillDirectory`。从 `/` 逐段 nofollow `openat`，冻结根身份，包身份在正文读取前校验，FD 枚举/普通文件读取及最终身份/纳秒元数据复验；拒绝链接、硬链接、越界、类型/数量/大小超限和替换。实际返回快照字节生成清单/内容摘要。5 秒/12 MiB 子进程限制，缺服务不回落 Node。`pnpm run dev` 和默认后台测试入口显式构建，业务路径不编译、不新增模型 Tool、网络或发送能力。
- 锁定/安装 DSH Skill 与 filesystem 均 `0.2.1-rc.2`、Cordis `4.0.5`。参考源码 `687f282e8625c6b8d11ff58211a90524be2e4317`，实际制品 `dsh-skill-filesystem/lib/index.js:584,597,620,709,712`：发现先解析各包全文、可选 fs 缺失/bundled 可回落 Node、watcher :371 独立接触宿主路径。采用规格允许的官方 `registerProvider` 业务受控替代，不启用 filesystem/default roots/bundled/watcher；未做源码到 npm 制品全量可复现构建比对。
- ADR-129 修订 ADR-096/098 的新包自动运行/应用技术更新条款，已回链并同步现行 Skill Library、core-flows、privacy-deletion 和早期草案。保留自动学习审核及用户原目录只读/删除边界。

实际命令（Node v24.19.0，arm64 macOS，本地合成资料，无真实模型或私人资料）：

1. `bash native/skill-read/build.sh`：通过；开始可用空间约 127 GiB，生成物按固定 `.build` 缓存复用且忽略 Git。
2. `cd backend-ts && node --test --test-name-pattern='发现与刷新未知' test/sqlite-skills.test.mjs`：先红（旧发现要求读取缺失正文），实现后 1/1 通过。
3. `node --test test/sqlite-skills.test.mjs test/sqlite-skill-http.test.mjs test/sqlite-skill-profile.test.mjs test/skill-files.test.mjs`：38/38 通过。
4. `node --test test/sqlite-skill-file-safety.test.mjs`：4/4 通过，含服务缺失、根/包同字节替换、祖先/正文/资源链接、硬链接、遍历、资源目录并发替换。
5. `pnpm run typecheck`：通过。`node --test --test-name-pattern='真实SQLite Skill库' test/sqlite-discussion-generation.test.mjs`：1/1 通过。
6. 开始前公开检查 `node scripts/check_public_history.mjs --ref HEAD --working-tree`：3019 历史提交、1546 当前文件、0 命中。最终提交后的检查由主 Agent 执行。

限制：原生部署目标为 arm64/macOS 15，未验证其他平台和发布包。正式 profile 测试复用官方 registry、真实 SQLite 与隔离认证/追踪夹具，无模型请求；真实 App、真实模型质量和外部渠道集成尚不能由这些结果认证。没有读取微信、发送消息、更新私人 Skill 目录、提交或远端操作。


### 独立审查后的修订

- Spec 审查指出固定 140 节点和 16 层资源目录限制会拒绝既有合同允许的包。新增 50 个目录/100 份资源与 48 层合法路径两条测试，先分别重现 `skill_package_invalid`；改为动态元数据索引与显式目录队列，文件/目录 FD 用后关闭，返回前逐段从绑定包 FD 重开复验，不再增加累计 FD 或深度上限。额外在 `ulimit -n 32` 子进程验证同一个 100 资源包成功。
- 默认全量暴露旧正式宿主测试仍期待初次 GET 空目录；按新合同改为精确断言自动发现一个 unknown/pending、零修订项目，自动刷新沿用同一 ID/head，确认启用才产生首个有效修订。未弱化认证、重开和原件字节断言。

修订验证：`node --test test/sqlite-skill-file-safety.test.mjs test/sqlite-skills.test.mjs test/sqlite-skill-profile.test.mjs test/sqlite-skill-resource-profile.test.mjs test/sqlite-skill-resources.test.mjs` 42/42 通过；正式宿主最小 case 1/1 通过。新增根目录超过 1024 包发现回归，继续只受既有调用时间/输出预算约束。


## Comments

2026-10-31：实现、独立双轴审查与隔离热更新 App 验收已完成。最终后台相关152/152、桌面相关27/27及两端类型检查通过；全量既有失败与测试分类缺口已归属，不冒称全量通过。实际命令、替身、数据影响、桌面操作与限制见 `backend-ts/src/reply/sqlite/README.md` 的“2026-10-31：DSH 回复 Skill 接入验收”。本轮未处理真实联系人资料、未发送外部消息、未制作发布包或推送远端。

本地提交：`cdb5d7a1`；隔离 App/监督器/供应商已正常退出，握手与锁已消失，本轮18,644 KiB合成环境已清理。


2026-10-31 用户取消 Skill 管理页的手动添加/手填目录名入口。当前合同为授权根自动刷新发现、明确启用停用、自动回复选择；内部目录登记保留为自动发现实现，不提供用户目录添加 API。相关 UI、bridge/IPC/HTTP 与回归由主 Agent 同步清理，原包与业务资料保留。
