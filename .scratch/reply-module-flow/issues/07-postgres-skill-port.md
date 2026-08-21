# 07 — 接入 PostgreSQL SkillPort

Type: task
State: open
Triage: ready-for-agent

**What to build:** 将只读 SkillPort 接入 PostgreSQL，为当前 owner 和 contact 提供正确的 Skill 目录、不可变版本正文和 owner 级修订，同时拒绝跨范围、禁用、删除或版本不一致的读取。

**Blocked by:** 02 — 统一回复与改写输入。

**Status:** ready-for-agent

- [ ] 目录只返回当前 owner 的全局 Skill 和当前 contact 的专属 Skill，并排除禁用或已删除版本。
- [ ] Skill 正文按不可变版本读取，owner 级 revision 变化后旧目录不能继续作为有效缓存。
- [ ] 跨 owner/contact、未知、禁用、删除或版本不一致的请求统一安全失败，不泄漏存在性细节。
- [ ] Reply Runtime 每次最多使用一个 Skill，并能保存实际版本、选择方式、原因和可空置信度。
- [ ] SkillPort 只提供读取能力，不新增安装、网络下载、更新、启用、禁用、删除或外部发送能力。
- [ ] 使用匿名合成 Skill 完成 PostgreSQL 约束和隔离测试，框架类型不泄漏到 Reply 公共接口。
