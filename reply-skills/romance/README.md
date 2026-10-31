# 92 个独立恋爱回复 Skill

按已确认的 92 个细分沟通任务制作，每个目录是一个独立包。分类仅用于浏览，不将多个场景重新合成大包。

每包的 `SKILL.md` 包含触发条件、邻近场景边界、具体步骤、反馈分支和完成条件。`references/cases.md` 含至少两则原创合成案例：当前对话、用户意图、候选、反例原因及后续接法；需要对照具体分支时才读取。案例事实只用于演示，实际候选以本轮已知事实和用户意愿为准。

包内容采用标准 name/description frontmatter，正文和案例独立自包含；不携带联系人资料、可执行脚本或外部读取能力。文件层面的来源编号对应 [固定来源](SOURCES.md)，完整清单以 [catalog.json](catalog.json) 为准。源方法经重新组织，案例不是历史聊天或人物语录的复制。

## 核验

在仓库根目录使用 Node.js 24 运行：

```sh
node scripts/validate_romance_reply_skills.mjs
cd backend-ts
node --test test/romance-reply-skills.test.mjs
```

校验使用产品实际的包解析和安全校验；加载回归使用隔离 SQLite、官方 DSH scoped registry 与产品 Skill provider，不调用外部模型，不读真实聊天。技术加载通过不代表所有场景的真实对话质量已完成验收。

应用在现有授权根内自动发现包，管理页沿用刷新、启用和停用流程；本套内容不增加手动添加或路径输入入口。制作和登记不代表已经启用，具体状态以管理页为准。

## 本轮验证

2026-10-31：92 个包、92 个案例资源及 184 则案例均通过产品实际包校验，零校验告警；名称、清单编号、来源范围及包内引用一致。

隔离 SQLite／DSH 回归通过：完整目录含 92 个已核验包，按需读取第 007、028、062、087 项的正文和同版本案例；每轮拒绝第二个包，宿主全局目录保持为空。两项既有正式 profile 回归同时通过，覆盖官方加载与正文后资源读取。

本机入库及实际 App 验证通过：复用现有开发实例，将 92 个包放入已配置的授权根，自动发现并逐一核验；管理页实际展示 92 项、中文描述及首尾条目。92 项均为“待核验启停 · 目录已核验”，本轮未统一启用，也未恢复手动添加入口。

内容经过分范围编写与交叉抽查，修正了案例中的无依据承诺、隐私边界、停止同意表达以及不够具体的后续接法。上述工程检查与内容审阅不代表 92 个场景均已完成真实模型效果验收。

## 清单

| 编号 | 独立 Skill | 场景分类 | 来源候选 |
| --- | --- | --- | --- |
| 001 | [初次开聊：承接共同经历或已知兴趣](romance-001-first-contact/SKILL.md) | 初识与重新开聊 | D09、G06、G29、E04、E19 |
| 002 | [对方慢热谨慎时的轻量破冰](romance-002-slow-warmup/SKILL.md) | 初识与重新开聊 | C09 |
| 003 | [很久没联系后的重新搭话](romance-003-reconnect-after-gap/SKILL.md) | 初识与重新开聊 | E17、G29、D12 |
| 004 | [例行问候聊成流水账后的重启](romance-004-refresh-routine-chat/SKILL.md) | 初识与重新开聊 | D12 |
| 005 | [回应“怎么突然找我”](romance-005-why-contact-now/SKILL.md) | 初识与重新开聊 | G01 |
| 006 | [延展对方已经抛出的话题](romance-006-topic-expansion/SKILL.md) | 接话与相互了解 | D10、G07 |
| 007 | [对方只回“哈哈”、表情或短词](romance-007-short-reply/SKILL.md) | 接话与相互了解 | G01、E05 |
| 008 | [连续查户口后改成双向分享](romance-008-interview-to-sharing/SKILL.md) | 接话与相互了解 | D07、D10、C14、G07 |
| 009 | [对方愿意回但不主动找话题](romance-009-passive-chat/SKILL.md) | 接话与相互了解 | C10 |
| 010 | [正在聊天但需要先结束](romance-010-close-chat/SKILL.md) | 接话与相互了解 | G26 |
| 011 | [原话题聊完或单次冷场后的转场](romance-011-topic-reset/SKILL.md) | 接话与相互了解 | G25、G26 |
| 012 | [分享自己的真实经历和生活状态](romance-012-share-experience/SKILL.md) | 接话与相互了解 | E26、C14 |
| 013 | [回应前任、恋爱史等问题](romance-013-past-relationships/SKILL.md) | 接话与相互了解 | D06 |
| 014 | [回应择偶标准、感情观等问题](romance-014-dating-values/SKILL.md) | 接话与相互了解 | D06、G32 |
| 015 | [被问暂时不想说的私人问题](romance-015-private-question/SKILL.md) | 接话与相互了解 | G26、E26 |
| 016 | [接住对方的玩笑、调侃和轻挑战](romance-016-playful-banter/SKILL.md) | 玩笑、暧昧与好感 | D04、D11、G08、C05 |
| 017 | [回应“你对谁都这样吗”的真诚质疑](romance-017-sincerity-challenge/SKILL.md) | 玩笑、暧昧与好感 | E05、G01、D11 |
| 018 | [基于真实细节夸奖对方](romance-018-specific-compliment/SKILL.md) | 玩笑、暧昧与好感 | G09、D18 |
| 019 | [轻度暧昧试探与接招](romance-019-light-flirting/SKILL.md) | 玩笑、暧昧与好感 | D13、G08、C05 |
| 020 | [轻松表达“想你了”](romance-020-miss-you/SKILL.md) | 玩笑、暧昧与好感 | G10 |
| 021 | [从朋友式相处表达不同的好感](romance-021-friend-to-romance/SKILL.md) | 玩笑、暧昧与好感 | C11、G10 |
| 022 | [从游戏搭子转成想和对方相处](romance-022-gaming-to-personal/SKILL.md) | 玩笑、暧昧与好感 | C13 |
| 023 | [表露好感后的接话与收住](romance-023-after-showing-interest/SKILL.md) | 玩笑、暧昧与好感 | C16、C04 |
| 024 | [暧昧过头、让对方不舒服后的收回](romance-024-flirt-repair/SKILL.md) | 玩笑、暧昧与好感 | D13、C03 |
| 025 | [试探对方是否愿意见面](romance-025-meeting-interest/SKILL.md) | 邀约与约会前后 | D14、C04、E08 |
| 026 | [把“有空约”落实为具体安排](romance-026-concrete-date-plan/SKILL.md) | 邀约与约会前后 | D14、G11、C07 |
| 027 | [通话或视频聊天的邀约](romance-027-call-video-invite/SKILL.md) | 邀约与约会前后 | E08 |
| 028 | [邀约只得到“下次吧”“再看看”](romance-028-vague-invite-response/SKILL.md) | 邀约与约会前后 | G11、E10 |
| 029 | [有见面意愿但时间冲突的协调](romance-029-schedule-conflict/SKILL.md) | 邀约与约会前后 | G11、E08 |
| 030 | [已经约好却临时取消或改期](romance-030-last-minute-cancel/SKILL.md) | 邀约与约会前后 | G11 |
| 031 | [见面前再次确认必要细节](romance-031-pre-date-confirmation/SKILL.md) | 邀约与约会前后 | G12、D15 |
| 032 | [约会临时增加朋友或同行者](romance-032-extra-companion/SKILL.md) | 邀约与约会前后 | D26、G12 |
| 033 | [见面时冷场或接不上话](romance-033-in-person-silence/SKILL.md) | 邀约与约会前后 | D25、G25 |
| 034 | [见面时说错话、出糗或尴尬的化解](romance-034-date-awkwardness/SKILL.md) | 邀约与约会前后 | G25、T02、T06 |
| 035 | [见面结束后的第一条跟进](romance-035-first-date-followup/SKILL.md) | 邀约与约会前后 | D16、E22、G16 |
| 036 | [承接上次体验提出再次见面](romance-036-next-date-invite/SKILL.md) | 邀约与约会前后 | D16、E22 |
| 037 | [约会不合拍时结束当次见面](romance-037-end-date/SKILL.md) | 邀约与约会前后 | E25 |
| 038 | [一条消息迟迟没有回复](romance-038-unanswered-message/SKILL.md) | 冷淡、被动与互动失衡 | E10、G21 |
| 039 | [多轮互动逐渐变冷](romance-039-fading-interaction/SKILL.md) | 冷淡、被动与互动失衡 | D21、E18、G15 |
| 040 | [对方忽冷忽热时稳定交流](romance-040-hot-cold-contact/SKILL.md) | 冷淡、被动与互动失衡 | C15、G21 |
| 041 | [对方说忙、困或想休息时收住](romance-041-busy-tired-exit/SKILL.md) | 冷淡、被动与互动失衡 | C03、C16 |
| 042 | [自己连发追问、解释过多后的降压](romance-042-after-overexplaining/SKILL.md) | 冷淡、被动与互动失衡 | C03 |
| 043 | [对方主要在需要帮助时才联系](romance-043-help-only-contact/SKILL.md) | 冷淡、被动与互动失衡 | C12、G15 |
| 044 | [长时间倾诉陪聊却没有双向相处](romance-044-one-sided-venting/SKILL.md) | 冷淡、被动与互动失衡 | C06、C12、G15 |
| 045 | [回应“达到某条件才考虑在一起”](romance-045-conditional-affection/SKILL.md) | 冷淡、被动与互动失衡 | C17 |
| 046 | [说有好感却持续回避见面等矛盾信息](romance-046-mixed-signals/SKILL.md) | 冷淡、被动与互动失衡 | C08、E10 |
| 047 | [对方难过或受委屈时回应](romance-047-sadness-support/SKILL.md) | 倾诉、支持与日常亲密 | D05、G20 |
| 048 | [对方焦虑、纠结或担忧未来时回应](romance-048-anxiety-support/SKILL.md) | 倾诉、支持与日常亲密 | G20 |
| 049 | [对方生气、抱怨别人或某件事时回应](romance-049-venting-about-others/SKILL.md) | 倾诉、支持与日常亲密 | G20 |
| 050 | [对方分享好消息或成果时捧场](romance-050-celebrate-good-news/SKILL.md) | 倾诉、支持与日常亲密 | G20、G09 |
| 051 | [对方身体不适或疲惫时关心](romance-051-illness-fatigue-care/SKILL.md) | 倾诉、支持与日常亲密 | D18、G20 |
| 052 | [感谢对方为自己做的具体事情](romance-052-specific-gratitude/SKILL.md) | 倾诉、支持与日常亲密 | E15、G09、G28 |
| 053 | [稳定关系中疏远后的重新亲近](romance-053-couple-reconnection/SKILL.md) | 倾诉、支持与日常亲密 | E17、E14 |
| 054 | [情侣之间提出或回应具体求助](romance-054-couple-help-request/SKILL.md) | 倾诉、支持与日常亲密 | G28、T02、G24 |
| 055 | [忙事业或学习时说明陪伴安排](romance-055-work-busy-relationship/SKILL.md) | 倾诉、支持与日常亲密 | T04 |
| 056 | [正式表白与回应表白](romance-056-confession/SKILL.md) | 关系确认与相处边界 | D17、G10 |
| 057 | [过早表白后的沟通补救](romance-057-premature-confession/SKILL.md) | 关系确认与相处边界 | D24 |
| 058 | [暧昧已久时问清彼此的关系意愿](romance-058-define-relationship/SKILL.md) | 关系确认与相处边界 | E12、C08、G14 |
| 059 | [明确排他性、称谓和承诺范围](romance-059-exclusivity-commitment/SKILL.md) | 关系确认与相处边界 | E12、G14 |
| 060 | [商量联系频率和消息回应期待](romance-060-contact-frequency/SKILL.md) | 关系确认与相处边界 | G14、G21、T03 |
| 061 | [表达独处、朋友或个人生活的空间需要](romance-061-personal-space/SKILL.md) | 关系确认与相处边界 | D19、E14、G14 |
| 062 | [身体亲密前后表达、确认和撤回同意](romance-062-physical-consent/SKILL.md) | 关系确认与相处边界 | D33、E27、G13 |
| 063 | [关系公开和合照发布的边界](romance-063-public-relationship-photos/SKILL.md) | 关系确认与相处边界 | G43 |
| 064 | [手机、密码、定位和查岗的边界](romance-064-digital-privacy/SKILL.md) | 关系确认与相处边界 | G43 |
| 065 | [吃醋或对异性交往不安时的沟通](romance-065-jealousy-conversation/SKILL.md) | 关系确认与相处边界 | E13、G43 |
| 066 | [表达不满与回应对方的不满](romance-066-express-dissatisfaction/SKILL.md) | 误解、冲突与修复 | D19、G22 |
| 067 | [前后说法矛盾时问清一个关键事实](romance-067-conflicting-statements/SKILL.md) | 误解、冲突与修复 | C08、G03、G19 |
| 068 | [文字或语气被误解后的澄清](romance-068-text-misunderstanding/SKILL.md) | 误解、冲突与修复 | E16、G22 |
| 069 | [失言伤到对方后的道歉](romance-069-hurtful-words-apology/SKILL.md) | 误解、冲突与修复 | E16、G23 |
| 070 | [失约或失信后的具体补救](romance-070-broken-promise-repair/SKILL.md) | 误解、冲突与修复 | G23 |
| 071 | [争执升温时暂停并约好恢复沟通](romance-071-conflict-pause/SKILL.md) | 误解、冲突与修复 | G22 |
| 072 | [冷战后重新开启对话](romance-072-reopen-after-silence/SKILL.md) | 误解、冲突与修复 | E16、E17 |
| 073 | [同一矛盾反复出现时协商可试行办法](romance-073-recurring-conflict/SKILL.md) | 误解、冲突与修复 | G22、G34 |
| 074 | [对方说“不合适”“不想恋爱”时回应](romance-074-romantic-rejection/SKILL.md) | 拒绝、分手与复联 | D27、G24 |
| 075 | [自己不想继续发展时说清楚](romance-075-end-dating-interest/SKILL.md) | 拒绝、分手与复联 | E23 |
| 076 | [被拒后仍需同学、同事式往来](romance-076-after-rejection-coworkers/SKILL.md) | 拒绝、分手与复联 | D23 |
| 077 | [聚会遇到对方新伴侣时的回应](romance-077-meet-new-partner/SKILL.md) | 拒绝、分手与复联 | D28 |
| 078 | [表达分手决定或回应分手](romance-078-breakup-conversation/SKILL.md) | 拒绝、分手与复联 | G39 |
| 079 | [分手后的物品和必要事务交接](romance-079-breakup-logistics/SKILL.md) | 拒绝、分手与复联 | G39 |
| 080 | [明确想尝试复联时写第一条消息](romance-080-reconnect-after-breakup/SKILL.md) | 拒绝、分手与复联 | G41 |
| 081 | [发现背叛后问清与沟通有关的事实](romance-081-betrayal-clarification/SKILL.md) | 拒绝、分手与复联 | G42 |
| 082 | [明确选择尝试修复后谈条件和具体行动](romance-082-trust-repair-conditions/SKILL.md) | 拒绝、分手与复联 | G42 |
| 083 | [见家长前商量意愿、分寸和安排](romance-083-meet-family/SKILL.md) | 长期恋爱与婚前家庭 | D20 |
| 084 | [谈是否结婚以及时间期待](romance-084-marriage-timing/SKILL.md) | 长期恋爱与婚前家庭 | D20、G33 |
| 085 | [谈生育意愿和未来责任预期](romance-085-parenthood-intentions/SKILL.md) | 长期恋爱与婚前家庭 | G33、G37 |
| 086 | [谈居住城市和未来生活安排](romance-086-city-future-life/SKILL.md) | 长期恋爱与婚前家庭 | D20、G33 |
| 087 | [谈共同开支和金钱边界](romance-087-shared-expenses/SKILL.md) | 长期恋爱与婚前家庭 | G35 |
| 088 | [谈日常家务和照护分工](romance-088-housework-care/SKILL.md) | 长期恋爱与婚前家庭 | G36 |
| 089 | [育儿或照护变化后重新商量分工](romance-089-caregiving-transition/SKILL.md) | 长期恋爱与婚前家庭 | G37 |
| 090 | [双方父母介入、探访和责任边界](romance-090-parents-boundaries/SKILL.md) | 长期恋爱与婚前家庭 | G38 |
| 091 | [重组家庭中前伴侣、孩子的往来边界](romance-091-blended-family/SKILL.md) | 长期恋爱与婚前家庭 | G38 |
| 092 | [提出并安排一次关系近况沟通](romance-092-relationship-checkin/SKILL.md) | 长期恋爱与婚前家庭 | G34 |
