# 03 — Skill 版本生命周期与回滚

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 用户可以明确更新、启用、停用或回滚 Owner 全局 Skill；每次更新产生新的不可变版本，目录和 Reply Runtime 始终使用明确的 current 版本，并能解释实际使用的版本。

**Blocked by:** 01 — Skill 版本、Owner 唯一名称和原子发布基础必须先存在。

- [x] 明确执行 update 才能导入同名新包；新包完整校验通过后才创建不可变新版本，并将其设为 current 和 active；旧版本保留且正文与资源不被覆盖。
- [x] 普通重复 import 不能偷偷变成 update；名称冲突、版本冲突和非法更新返回不泄漏其他 Owner 或联系人资料的可解释结果。
- [x] enable、disable 和 rollback 都是 Owner 范围内的显式管理操作；停用 Skill 不进入运行目录，回滚能把已保留的旧版本设为 current 并恢复可用。
- [x] import、update、enable、disable 和 rollback 每次在同一事务中递增一次 `skill_library_revision`；只有一个 current 版本，失败不能留下半切换状态。
- [x] 目录缓存、资源读取结果和运行时版本判断会在 revision 变化后失效；后续候选只能记录并使用新的有效版本。
- [x] 历史 Reply Task 仍能关联当时实际使用的版本；新候选显示切换后的 Skill 版本和选择原因。
- [x] 使用合成 PostgreSQL 数据覆盖多版本、重复更新、停用、启用、回滚、并发或重复操作、revision 和 Owner 隔离。

## Answer

已完成 Ticket 03：`PostgresSkillLibrary` 新增 `update_package`、`enable`、`disable` 和 `rollback` 四个 Owner 范围管理操作。

1、update 对同一名称下的新包做完整校验后在单个事务中创建不可变新版本并设为 current/active，旧版本正文与资源原样保留；普通重复 import 依旧抛名称冲突，不会偷偷升级为 update。
2、enable/disable 原子切换 `reply_skill.status` 并只在真实状态变化时递增 revision；disabled Skill 不再进入运行目录。
3、rollback 把已保留的 active 旧版本设为唯一 current 并恢复 Skill active，缺失或已删版本抛出可解释错误；每次操作都只有一个 current 版本。
4、所有操作都在事务中递增 Owner 级 `skill_library_revision` 一次，越权或不存在统一安全失败、不泄漏其他 Owner 的存在性。
5、真实验证：新增 8 个 PostgreSQL 生命周期集成测试全部通过；全仓 445 个测试通过、2 个跳过，`git diff --check` 干净。

## Comments

- 来源规格：`.scratch/skill-library/spec.md`。
- 本票不负责删除历史版本；删除全部正文、资源和运行期缓存由第 04 票负责。
- 2026-10-12账本对账：按仓库五种Triage角色将误写的`resolved`纠正为`ready-for-agent`，完成状态仍由`State: resolved`表达。原验收勾选、Answer及历史验证结果保持；本次未重跑产品测试。对账见[记录](../../unfinished-work/ledger-reconciliation-20261012.md)。
