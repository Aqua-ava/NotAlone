# DSH Skill 接入与业务校验草案

> 状态：讨论与隔离实验记录，不代表已实现或替代现行规格。自动学习的具体规则暂不讨论。现行 Skill 范围和生命周期见 [Skill Library](../current/skill-library.md)，DSH 接入约束见 [ADR-102](../adr/102-dsh-typescript-backend-migration.md)。

## 目标和职责

尽量使用 DSH 的通用 Skill 能力，由 NotAlone 业务适配层控制可用范围、版本、来源和使用记录。业务适配层可以通过 DSH 插件装配，是否将每个业务模块插件化尚未决定。

- `dsh-skill`：Skill 注册、作用域和加载接口；当前已在使用。
- `dsh-skill-filesystem`：候选的本地 Skill 发现与读取能力；能否满足受控读取要求，仍需验证。
- `dsh-tool-skill`：候选的模型侧目录与按需加载工具；业务 provider 继续控制可用内容和单次使用上限。
- NotAlone 业务适配层：管理启停、有效修订、联系人与来源范围，校验实际读取内容，并记录本次输入；Skill 不获得脚本、网络或发送消息的权限。

讨论中确认：新发现的 Skill 需用户启用；Skill 更新直接由应用处理，用户不需要自行编辑或逐次确认。生成回复时由模型根据当前对话自动判断是否使用 Skill，每轮最多使用一个，也可以不使用；用户查看和选择最终回复。更新过程中的版本切换与在途调用如何处理，尚待设计。自动学习如何修改 Skill 以及其审核、来源和撤销规则留待后续讨论；现行 [ADR-048](../adr/048-memory-skill-evolution-lifecycle.md) 对学习草稿和审核的约束没有因本草案改变。

现行 [Skill Library](../current/skill-library.md) 对合法目录包自动发现和发布的描述，与当前 SQLite 实现的明确关联、启用流程有差异。本讨论中的新包启用方向需要后续结合实际产品入口收敛，不能视为规格已经修订。

## 文件读取的实验结果

2026-10-31 使用本机安装的 `0.2.1-rc.2` 官方 `dsh-skill` 和 `dsh-skill-filesystem`，在临时目录运行合成实验。真实 DSH registry 与 filesystem provider 经实验性业务包装层连接现有 `SqliteSkillLibrary`；数据库使用 SQLite 测试夹具，provider 使用指定根目录、关闭默认根目录及 watcher。未修改产品代码、使用真实用户资料或调用模型。实验脚本为临时内联脚本，运行后未保留，以下是实际观察而非可复跑验收记录。

1. **组合可行**：对已关联、启用且已核验的合成 Skill，DSH 正文与业务读取的正文一致；经过包装后模型侧可见虚拟路径。停用后，业务校验拒绝旧修订的读取。
2. **过滤发生得太晚**：官方 provider 列目录时读取了指定根目录中的未关联 Skill，且发现了指向根目录外的合成符号链接。实验中的业务目录过滤只能阻止它们进入返回结果，不能撤销已经发生的文件读取；现有业务库拒绝关联该符号链接。
3. **前后校验不能证明中间读到的内容**：实验人为安排文件从 A 改为 B、DSH 读取 B、再恢复 A。业务读取前后对 A 的修订检查均通过；对比 DSH 实际返回的正文后发现 B 并拒绝。该对比只验证了此合成文本，不代表已经解决所有编码、格式、资源及并发问题。

实验中未关联的 Skill 没有进入模型目录，也没有进入模型请求。这里的风险是**本机文件已被 DSH 扫描读取**，不能据此声称这些文件已经发送给模型。

## 需要解决的问题

- **读取范围**：确认官方 provider 的公开扩展点能否在实际扫描和读取之前限制范围并拒绝符号链接。`watchFollowSymlinks` 控制 watcher，不能据此推断读取行为；扫描后过滤不够。若不能满足，保留必要的受控读取，不直接挂载开放扫描的 provider。
- **实际内容与修订一致**：不仅检查读取前后的状态，还要证明交给模型的具体内容来自有效修订，并处理并发替换、资源和规范化差异。不能仅凭本次字符串对比证明安全。
- **辅助资源**：`references/` 和 `assets/` 需要与同一有效版本绑定并受控读取。官方 watcher 不覆盖资源内部变化；本次实验未验证资源。
- **模型加载流程**：当前回复链禁止工具且只允许一次模型调用；接入 `dsh-tool-skill` 需要调整有界调用、预算、取消、每次出站前复验和持久会话删除等环节，仍保持每轮最多一个 Skill。本次实验未运行 `dsh-tool-skill` 或模型。
- **自动学习**：本轮明确暂缓，不根据应用更新规则推断学习草稿是否自动发布。

## 源码依据

- 官方固定参考提交 `687f282e8625c6b8d11ff58211a90524be2e4317`：[文件系统 provider](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-filesystem/src/index.ts#L148)、[模型 Skill 工具](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/tool-skill/src/index.ts#L75)。安装包与此提交未做全量可复现构建比对。
- 当前项目：[业务 Skill provider](../../backend-ts/src/skills/sqlite/provider.ts)、[文件校验](../../backend-ts/src/skills/skill-package.ts)、[回复生成](../../backend-ts/src/reply/sqlite/generation.ts)。
- 已锁定并安装相关 DSH 版本 `0.2.1-rc.2`；`dsh-skill-filesystem` 和 `dsh-tool-skill` 是依赖图中的安装包，尚未作为当前业务 profile 的直接插件装配。
