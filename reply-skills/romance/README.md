# 92 个独立恋爱回复 Skill

按已确认的 92 个细分沟通场景保留独立包。92 是整理后的目录数量，不表示原仓库已有 92 个独立 Skill 文件。

方法、表达模板、话术片段及教学情境只取原文件的连续行段，不另写人物、背景、用户意图、反例或后续对话。登记在 `translations.json` 的完整英文摘录以中文译文显示，逐条绑定固定来源行号和摘要；其它原文保持不变。编排仅增加场景名称、description、章节及按需读取提示，去除片段首尾空行与行尾空白。原文模板中的假设和占位符不能当作用户事实。

本版包含 128 段方法摘录、89 段单列示例摘录，其中 80 段示例的引用范围不同；重复引用不算新的案例。76 项有对应场景的方法，16 项借用相关通用方法；13 项没有合适的单列示例，明确留空，不凑数。旧版自行编写的 184 则案例已撤回。

每个 `SKILL.md` 只放方法和示例读取提示，`references/cases.md` 按需提供已有表达参考。仓库、文件、行号、适用性备注统一放在 [独立来源文档](SOURCES.md) 和 [机器可核验的来源表](provenance.json)，不放进正文或示例；原作者许可同样集中到来源文档，单个包内不再放 `LICENSES.txt`。完整原文件快照保存在包外的 [romance-sources](../romance-sources/README.md)。

## 使用与核验

内容采用标准 name/description frontmatter，不携带联系人资料、可执行脚本或外部读取能力。日常开发新实例默认从本目录读取，已有显式配置仍优先；应用只在已授权根自动发现并完整核验，通过后默认启用，明确停用或来源失效不恢复。包修订、多 Skill 加载、资源预算和原目录只读规则统一见[现行 Skill 合同](../../architecture/current/skill-library.md)。运行检查脚本本身不改变 App 的启停决定。

在仓库根目录使用 Node.js 24。只读内容核验与相关合成回归：

```sh
node scripts/validate_romance_reply_skills.mjs
cd backend-ts
node --test test/romance-source-material.test.mjs test/romance-chinese-localization.test.mjs test/romance-reply-skills.test.mjs test/sqlite-skill-profile.test.mjs test/sqlite-skill-resource-profile.test.mjs
```

需要根据已登记材料重建包时，显式运行 `node scripts/render_romance_reply_skills.mjs`；该命令会改写本目录的生成内容。生成器只接受原文行段及绑定来源摘要的中文译文。校验器核对固定仓库与提交、源文件 Git blob／SHA-256、引用行号和片段哈希，并与[源文件锁表](../romance-sources.lock.json)匹配；来源文档、许可、方法与示例须一起保持一致。

技术加载回归使用隔离 SQLite、官方 DSH scoped registry 与产品 Skill provider，不调用外部模型，不改真实聊天或记忆。结构校验与加载成功不代表 92 个场景的实际回复效果均已验收。

## 清单

| 编号 | 独立 Skill | 场景分类 | 方法范围 | 单列示例段数 |
| --- | --- | --- | --- | --- |
| 001 | [初次开聊：承接共同经历或已知兴趣](romance-001-first-contact/SKILL.md) | 初识与重新开聊 | 对应场景方法 | 1 |
| 002 | [对方慢热谨慎时的轻量破冰](romance-002-slow-warmup/SKILL.md) | 初识与重新开聊 | 通用方法 | 未单列 |
| 003 | [很久没联系后的重新搭话](romance-003-reconnect-after-gap/SKILL.md) | 初识与重新开聊 | 对应场景方法 | 1 |
| 004 | [例行问候聊成流水账后的重启](romance-004-refresh-routine-chat/SKILL.md) | 初识与重新开聊 | 通用方法 | 未单列 |
| 005 | [回应“怎么突然找我”](romance-005-why-contact-now/SKILL.md) | 初识与重新开聊 | 对应场景方法 | 1 |
| 006 | [延展对方已经抛出的话题](romance-006-topic-expansion/SKILL.md) | 接话与相互了解 | 对应场景方法 | 1 |
| 007 | [对方只回“哈哈”、表情或短词](romance-007-short-reply/SKILL.md) | 接话与相互了解 | 对应场景方法 | 2 |
| 008 | [连续查户口后改成双向分享](romance-008-interview-to-sharing/SKILL.md) | 接话与相互了解 | 对应场景方法 | 1 |
| 009 | [对方愿意回但不主动找话题](romance-009-passive-chat/SKILL.md) | 接话与相互了解 | 对应场景方法 | 1 |
| 010 | [正在聊天但需要先结束](romance-010-close-chat/SKILL.md) | 接话与相互了解 | 通用方法 | 1 |
| 011 | [原话题聊完或单次冷场后的转场](romance-011-topic-reset/SKILL.md) | 接话与相互了解 | 对应场景方法 | 1 |
| 012 | [分享自己的真实经历和生活状态](romance-012-share-experience/SKILL.md) | 接话与相互了解 | 对应场景方法 | 1 |
| 013 | [回应前任、恋爱史等问题](romance-013-past-relationships/SKILL.md) | 接话与相互了解 | 对应场景方法 | 1 |
| 014 | [回应择偶标准、感情观等问题](romance-014-dating-values/SKILL.md) | 接话与相互了解 | 对应场景方法 | 1 |
| 015 | [被问暂时不想说的私人问题](romance-015-private-question/SKILL.md) | 接话与相互了解 | 通用方法 | 1 |
| 016 | [接住对方的玩笑、调侃和轻挑战](romance-016-playful-banter/SKILL.md) | 玩笑、暧昧与好感 | 对应场景方法 | 1 |
| 017 | [回应“你对谁都这样吗”的真诚质疑](romance-017-sincerity-challenge/SKILL.md) | 玩笑、暧昧与好感 | 对应场景方法 | 2 |
| 018 | [基于真实细节夸奖对方](romance-018-specific-compliment/SKILL.md) | 玩笑、暧昧与好感 | 对应场景方法 | 1 |
| 019 | [轻度暧昧试探与接招](romance-019-light-flirting/SKILL.md) | 玩笑、暧昧与好感 | 对应场景方法 | 1 |
| 020 | [轻松表达“想你了”](romance-020-miss-you/SKILL.md) | 玩笑、暧昧与好感 | 对应场景方法 | 1 |
| 021 | [从朋友式相处表达不同的好感](romance-021-friend-to-romance/SKILL.md) | 玩笑、暧昧与好感 | 对应场景方法 | 1 |
| 022 | [从游戏搭子转成想和对方相处](romance-022-gaming-to-personal/SKILL.md) | 玩笑、暧昧与好感 | 对应场景方法 | 1 |
| 023 | [表露好感后的接话与收住](romance-023-after-showing-interest/SKILL.md) | 玩笑、暧昧与好感 | 对应场景方法 | 1 |
| 024 | [暧昧过头、让对方不舒服后的收回](romance-024-flirt-repair/SKILL.md) | 玩笑、暧昧与好感 | 通用方法 | 未单列 |
| 025 | [试探对方是否愿意见面](romance-025-meeting-interest/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 1 |
| 026 | [把“有空约”落实为具体安排](romance-026-concrete-date-plan/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 1 |
| 027 | [通话或视频聊天的邀约](romance-027-call-video-invite/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 1 |
| 028 | [邀约只得到“下次吧”“再看看”](romance-028-vague-invite-response/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 1 |
| 029 | [有见面意愿但时间冲突的协调](romance-029-schedule-conflict/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 1 |
| 030 | [已经约好却临时取消或改期](romance-030-last-minute-cancel/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 1 |
| 031 | [见面前再次确认必要细节](romance-031-pre-date-confirmation/SKILL.md) | 邀约与约会前后 | 通用方法 | 未单列 |
| 032 | [约会临时增加朋友或同行者](romance-032-extra-companion/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 2 |
| 033 | [见面时冷场或接不上话](romance-033-in-person-silence/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 3 |
| 034 | [见面时说错话、出糗或尴尬的化解](romance-034-date-awkwardness/SKILL.md) | 邀约与约会前后 | 通用方法 | 1 |
| 035 | [见面结束后的第一条跟进](romance-035-first-date-followup/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 1 |
| 036 | [承接上次体验提出再次见面](romance-036-next-date-invite/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 1 |
| 037 | [约会不合拍时结束当次见面](romance-037-end-date/SKILL.md) | 邀约与约会前后 | 对应场景方法 | 未单列 |
| 038 | [一条消息迟迟没有回复](romance-038-unanswered-message/SKILL.md) | 冷淡、被动与互动失衡 | 对应场景方法 | 1 |
| 039 | [多轮互动逐渐变冷](romance-039-fading-interaction/SKILL.md) | 冷淡、被动与互动失衡 | 对应场景方法 | 1 |
| 040 | [对方忽冷忽热时稳定交流](romance-040-hot-cold-contact/SKILL.md) | 冷淡、被动与互动失衡 | 对应场景方法 | 1 |
| 041 | [对方说忙、困或想休息时收住](romance-041-busy-tired-exit/SKILL.md) | 冷淡、被动与互动失衡 | 对应场景方法 | 1 |
| 042 | [自己连发追问、解释过多后的降压](romance-042-after-overexplaining/SKILL.md) | 冷淡、被动与互动失衡 | 对应场景方法 | 未单列 |
| 043 | [对方主要在需要帮助时才联系](romance-043-help-only-contact/SKILL.md) | 冷淡、被动与互动失衡 | 对应场景方法 | 未单列 |
| 044 | [长时间倾诉陪聊却没有双向相处](romance-044-one-sided-venting/SKILL.md) | 冷淡、被动与互动失衡 | 对应场景方法 | 1 |
| 045 | [回应“达到某条件才考虑在一起”](romance-045-conditional-affection/SKILL.md) | 冷淡、被动与互动失衡 | 对应场景方法 | 1 |
| 046 | [说有好感却持续回避见面等矛盾信息](romance-046-mixed-signals/SKILL.md) | 冷淡、被动与互动失衡 | 通用方法 | 1 |
| 047 | [对方难过或受委屈时回应](romance-047-sadness-support/SKILL.md) | 倾诉、支持与日常亲密 | 对应场景方法 | 1 |
| 048 | [对方焦虑、纠结或担忧未来时回应](romance-048-anxiety-support/SKILL.md) | 倾诉、支持与日常亲密 | 对应场景方法 | 1 |
| 049 | [对方生气、抱怨别人或某件事时回应](romance-049-venting-about-others/SKILL.md) | 倾诉、支持与日常亲密 | 对应场景方法 | 1 |
| 050 | [对方分享好消息或成果时捧场](romance-050-celebrate-good-news/SKILL.md) | 倾诉、支持与日常亲密 | 对应场景方法 | 1 |
| 051 | [对方身体不适或疲惫时关心](romance-051-illness-fatigue-care/SKILL.md) | 倾诉、支持与日常亲密 | 通用方法 | 1 |
| 052 | [感谢对方为自己做的具体事情](romance-052-specific-gratitude/SKILL.md) | 倾诉、支持与日常亲密 | 对应场景方法 | 1 |
| 053 | [稳定关系中疏远后的重新亲近](romance-053-couple-reconnection/SKILL.md) | 倾诉、支持与日常亲密 | 对应场景方法 | 1 |
| 054 | [情侣之间提出或回应具体求助](romance-054-couple-help-request/SKILL.md) | 倾诉、支持与日常亲密 | 通用方法 | 1 |
| 055 | [忙事业或学习时说明陪伴安排](romance-055-work-busy-relationship/SKILL.md) | 倾诉、支持与日常亲密 | 对应场景方法 | 1 |
| 056 | [正式表白与回应表白](romance-056-confession/SKILL.md) | 关系确认与相处边界 | 对应场景方法 | 2 |
| 057 | [过早表白后的沟通补救](romance-057-premature-confession/SKILL.md) | 关系确认与相处边界 | 对应场景方法 | 1 |
| 058 | [暧昧已久时问清彼此的关系意愿](romance-058-define-relationship/SKILL.md) | 关系确认与相处边界 | 对应场景方法 | 1 |
| 059 | [明确排他性、称谓和承诺范围](romance-059-exclusivity-commitment/SKILL.md) | 关系确认与相处边界 | 对应场景方法 | 1 |
| 060 | [商量联系频率和消息回应期待](romance-060-contact-frequency/SKILL.md) | 关系确认与相处边界 | 对应场景方法 | 1 |
| 061 | [表达独处、朋友或个人生活的空间需要](romance-061-personal-space/SKILL.md) | 关系确认与相处边界 | 对应场景方法 | 未单列 |
| 062 | [身体亲密前后表达、确认和撤回同意](romance-062-physical-consent/SKILL.md) | 关系确认与相处边界 | 对应场景方法 | 1 |
| 063 | [关系公开和合照发布的边界](romance-063-public-relationship-photos/SKILL.md) | 关系确认与相处边界 | 对应场景方法 | 1 |
| 064 | [手机、密码、定位和查岗的边界](romance-064-digital-privacy/SKILL.md) | 关系确认与相处边界 | 对应场景方法 | 1 |
| 065 | [吃醋或对异性交往不安时的沟通](romance-065-jealousy-conversation/SKILL.md) | 关系确认与相处边界 | 通用方法 | 1 |
| 066 | [表达不满与回应对方的不满](romance-066-express-dissatisfaction/SKILL.md) | 误解、冲突与修复 | 对应场景方法 | 1 |
| 067 | [前后说法矛盾时问清一个关键事实](romance-067-conflicting-statements/SKILL.md) | 误解、冲突与修复 | 对应场景方法 | 1 |
| 068 | [文字或语气被误解后的澄清](romance-068-text-misunderstanding/SKILL.md) | 误解、冲突与修复 | 对应场景方法 | 1 |
| 069 | [失言伤到对方后的道歉](romance-069-hurtful-words-apology/SKILL.md) | 误解、冲突与修复 | 对应场景方法 | 1 |
| 070 | [失约或失信后的具体补救](romance-070-broken-promise-repair/SKILL.md) | 误解、冲突与修复 | 通用方法 | 1 |
| 071 | [争执升温时暂停并约好恢复沟通](romance-071-conflict-pause/SKILL.md) | 误解、冲突与修复 | 对应场景方法 | 1 |
| 072 | [冷战后重新开启对话](romance-072-reopen-after-silence/SKILL.md) | 误解、冲突与修复 | 通用方法 | 1 |
| 073 | [同一矛盾反复出现时协商可试行办法](romance-073-recurring-conflict/SKILL.md) | 误解、冲突与修复 | 对应场景方法 | 2 |
| 074 | [对方说“不合适”“不想恋爱”时回应](romance-074-romantic-rejection/SKILL.md) | 拒绝、分手与复联 | 对应场景方法 | 2 |
| 075 | [自己不想继续发展时说清楚](romance-075-end-dating-interest/SKILL.md) | 拒绝、分手与复联 | 对应场景方法 | 1 |
| 076 | [被拒后仍需同学、同事式往来](romance-076-after-rejection-coworkers/SKILL.md) | 拒绝、分手与复联 | 对应场景方法 | 2 |
| 077 | [聚会遇到对方新伴侣时的回应](romance-077-meet-new-partner/SKILL.md) | 拒绝、分手与复联 | 对应场景方法 | 未单列 |
| 078 | [表达分手决定或回应分手](romance-078-breakup-conversation/SKILL.md) | 拒绝、分手与复联 | 对应场景方法 | 1 |
| 079 | [分手后的物品和必要事务交接](romance-079-breakup-logistics/SKILL.md) | 拒绝、分手与复联 | 对应场景方法 | 1 |
| 080 | [明确想尝试复联时写第一条消息](romance-080-reconnect-after-breakup/SKILL.md) | 拒绝、分手与复联 | 对应场景方法 | 未单列 |
| 081 | [发现背叛后问清与沟通有关的事实](romance-081-betrayal-clarification/SKILL.md) | 拒绝、分手与复联 | 对应场景方法 | 未单列 |
| 082 | [明确选择尝试修复后谈条件和具体行动](romance-082-trust-repair-conditions/SKILL.md) | 拒绝、分手与复联 | 对应场景方法 | 1 |
| 083 | [见家长前商量意愿、分寸和安排](romance-083-meet-family/SKILL.md) | 长期恋爱与婚前家庭 | 通用方法 | 未单列 |
| 084 | [谈是否结婚以及时间期待](romance-084-marriage-timing/SKILL.md) | 长期恋爱与婚前家庭 | 通用方法 | 1 |
| 085 | [谈生育意愿和未来责任预期](romance-085-parenthood-intentions/SKILL.md) | 长期恋爱与婚前家庭 | 对应场景方法 | 1 |
| 086 | [谈居住城市和未来生活安排](romance-086-city-future-life/SKILL.md) | 长期恋爱与婚前家庭 | 对应场景方法 | 1 |
| 087 | [谈共同开支和金钱边界](romance-087-shared-expenses/SKILL.md) | 长期恋爱与婚前家庭 | 对应场景方法 | 1 |
| 088 | [谈日常家务和照护分工](romance-088-housework-care/SKILL.md) | 长期恋爱与婚前家庭 | 对应场景方法 | 1 |
| 089 | [育儿或照护变化后重新商量分工](romance-089-caregiving-transition/SKILL.md) | 长期恋爱与婚前家庭 | 通用方法 | 1 |
| 090 | [双方父母介入、探访和责任边界](romance-090-parents-boundaries/SKILL.md) | 长期恋爱与婚前家庭 | 对应场景方法 | 1 |
| 091 | [重组家庭中前伴侣、孩子的往来边界](romance-091-blended-family/SKILL.md) | 长期恋爱与婚前家庭 | 对应场景方法 | 未单列 |
| 092 | [提出并安排一次关系近况沟通](romance-092-relationship-checkin/SKILL.md) | 长期恋爱与婚前家庭 | 对应场景方法 | 2 |

阶段实现和旧验收记录已移至[开发历史](../../docs/history/backend-development-history.md)；历史数字不表示当前版本通过。
