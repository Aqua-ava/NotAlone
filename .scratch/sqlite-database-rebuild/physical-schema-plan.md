# SQLite 物理设计讨论入口

状态：任务10仍在讨论。用户未认可94张表，已撤回推荐；Q43暂缓。当前从[业务事实重新设计](greenfield-design.md)，旧候选审查仅作问题记录；重新推导实体、关系、字段和DDL。

## 当前工作顺序

1. 从已确认需求列必须保存的事实，区分用户决定、既有约束与Agent建议。
2. 逐项说明行粒度、独立理由、键、关系、合并／不建及取舍。旧PG有表、有消费者或任务resolved，都不代表新库必须有同名物理表。
3. 明确基础范围和未确定纳入的扩展能力，再形成唯一物理表方案。
4. 最后讨论Q43材料结构；不按哈希合并权限，不用JSON引用数组降低表数。

## 历史数量的正确位置

前一轮从107项逻辑草案、3个查漏补项及2个元数据推导94／100候选，尚未证明逐表必要性，用户没有认可。112项是**审查对象**，不是拟建112张表。

[历史候选](physical-table-catalog.md)、[机器清单](physical-catalog.json)和[旧PG覆盖](physical-coverage.md)仅供对照。共享材料两表是未选替代方案，不是基础建表要求。

Q36—Q42明确决定仍有效；“保留Skill原目录并用DSH加载”不自动扩成重建完整学习、方法继承、双侧审核与质量平台。以下技术研究可继续使用，但不能证明某张业务表必须存在，也不是最终DDL。

## 5. 统一SQLite类型和键

| 数据 | 物理合同 |
| --- | --- |
| 内部UUID、外部身份／不透明cursor | TEXT；命名空间和协议规范化明确，昵称／正文hash不作身份 |
| 主键／复合键 | 每列显式NOT NULL；同owner/contact复合FK，不依赖仅UUID相等 |
| 系统时间 | INTEGER UTC毫秒；事实发生时间、适用区间、精度及未知保持来源合同，不以保存时间补齐 |
| 版本／代次／数量 | INTEGER＋明确非负／正数CHECK；单条版本、集合修订、授权代次不同列，不能互相替代 |
| 布尔 | INTEGER NOT NULL CHECK IN(0,1)；Q41启用未知专门允许NULL并标待核验，不写成停用 |
| 金额 | INTEGER amount_units＋明确scale/currency/pricing_version；未知NULL，分币种汇总，溢出拒绝不截断 |
| 受控结构值／实际载荷 | TEXT＋json_valid等已核验内置函数和版本合同；实体关系仍独立FK列；敏感载荷可清NULL |
| 枚举／状态 | TEXT＋CHECK，字段NULL形状写成确定布尔，不利用CHECK的NULL结果放过缺项 |

原则上STRICT；关系表WITHOUT ROWID只在无rowid依赖且查询／空间对比后选，不宣称默认更快。SQLite无默认regexp，不伪造PostgreSQL UUID／JSONB／正则／GIN／advisory lock能力。UUID格式在受控入口规范化，必要DDL用可验证内置CHECK。

node:sqlite读64位整数时显式BigInt；DTO按字段检查安全范围后转number或十进制字符串，不能直接JSON.stringify(BigInt)。外部大ID在CLI解析阶段就须无损，存库后无法补回此前JS number丢失的精度。

## 6. FK、唯一性与索引

- 每个owner范围主表有独立owner FK；含NULL的contact复合FK不能代替它。owner唯一与contact唯一分别部分索引。
- FK负责引用完整性，不替代查询授权。所有读写命令显式使用可信owner/contact及确认范围，缺scope拒绝，不向模型或公开API暴露任意SQL／连接对象。
- current version完整包含本entity_id及version_no；父版同根，合并父边同scope并防环；候选从v1统一正文。循环FK用有证明的DEFERRABLE NO ACTION，RESTRICT动作立即执行。
- 普通来源／证据依赖默认不无条件CASCADE，删除协议先捕获闭包。deletion_target只FK operation，其地址是待删快照，故意不FK将消失的live对象。
- 部分索引保证同绑定仅一个当前active grant、同会话一个current、每真实请求一个未结算物理尝试等；索引条件与状态机一起验证。
- model_call_execution对step/assistant/quality三分支分别设置真实FK及排他CHECK；每call一行使归属互斥。质量调用槽也有定义，不为容纳账目伪造step；Skill审核结果依然指实际产出attempt及消费call链。
- 必要访问路径：消息scope+身份去重／分页；各类材料反向目标；memory当前scope／版本；task状态+租约；call的request+序号；发布集合成员；方法祖先／政策范围；删除operation+target state。
- 同字段PK/UNIQUE已覆盖的索引不重复创建；低选择性的所有状态位不一律索引。最终每条索引对应一个真实查询和EXPLAIN QUERY PLAN，不靠猜测增加。
- 当前检索为范围／来源过滤后的词法排序，本地embedding无已发现持久向量表消费者；不为换库额外创建FTS／向量表。若以后新增须有实际负载与来源删除验证。

## 7. 驱动、执行与事务边界建议

建议以当前Electron内嵌node:sqlite为首选实现基线，放在专用存储Worker中。当前是Node 24.21的RC接口，须固定运行时和复验；不新增未核验原生addon。已证明Worker可加载模块，不等于生产接线或性能通过。

业务模块使用具名事务操作，如acceptRun、reserveCall、commitMemoryBatch、publishDocumentSet、acceptDeletion；传明确scope／预期版本并返回DTO。不将任意pg.Client callback或一条条远程SQL代理穿过Worker，也不在写事务等待模型、CLI或文件I/O。DSH官方profile／薄插件注入业务存储，SQL不注册为产品Tool。

写入先单一受管连接／有界队列，模型与CLI并发在事务外；只对确定未执行的数据库busy重试，不自动重发模型。读连接数、锁等待上限、批次大小由实际负载确定，不能把探针的timeout当产品预算。

逐连接明确并读回foreign_keys；候选配置WAL、synchronous=FULL、关闭扩展加载，secure_delete及删除维护按存储合同实测。长期读者阻止checkpoint时保留清理未完成，不手删活WAL。完整schema、虚拟表、磁盘故障和崩溃恢复仍须另验。

## 8. 文件身份、初始化与迁移

database_instance单例保存database_id、format_family、role、created_at及当前格式位置；是否独立保留schema_migration逐脚本checksum/applied_at历史，按当前需求审查列为条件项，不默认建。应用配置绑定预期实例，路径来自受管资料根，不用当前工作目录或测试路径当默认业务库。

新SQLite独立v1结构及追加迁移，不重放128份PG迁移或伪造旧ledger。app_id/user_version作为格式／版本辅助，不能代替校验和账本。首建需要已知初始化状态；文件丢失、权限错误、损坏、版本过新或checksum不符时拒绝使用，不能catch后换空库或自动删库重建。

目录／文件最小权限、无路径替换和实例归属须验证。正常升级不创建用户未要求的旧库备份；本次明确从空重建也不保留旧PG dump。敏感快照、WAL、受管会话等按删除协议复核，不宣称SQL DELETE等于所有SSD／供应商副本不可恢复。

## 9. 切换顺序与不可跳过的门禁

1. 新schema与全部字段／FK／索引在隔离合成库验证；保留115表所有实际接口的正向及删除／失败覆盖，旧文件导入、媒体获取、升级任务按既有决定退役入口。
2. 解决CLI稳定身份与精确清空分界合同，验证同秒／乱序／重复编号、未读历史、清空期间到达、重启和旧页迟到；未证不得验收Q24，不用时间/maxID或Q32隔离回存旧正文。
3. 新存储命令与真实业务模块、正式DSH接线集成；热更新桌面按dev:status复用pnpm run dev，未经用户发布任务不打包或运行包。
4. 准备新业务文件与实例身份，业务数据为空；Q41原Skill目录保持原位、官方加载，只核验并重建必要关联。已知启用／停用按证据，未知单项待核验；先禁用缺DB引用即清理路径，不洗审核来源。
5. 以精确目标识别旧PG与App副本，持久化最小删除清单于新存储或独立控制清单；它不能只存在即将drop的旧PG里，不含聊天／凭据，不是备份。
6. 撤销并排空旧writer、同步、模型及文件写入；旧epoch结果只能合法结算，不再创建业务或复活owner/contact。记录未知请求，不自动接续旧任务。
7. 新配置指向已验证实例，保留模型密钥及用户原始文件；精确清旧NotAlone业务库和受管敏感副本，不调用会删Skill工作目录的旧account路径，不遍历删除其他独立包。
8. 逐面验证数据库、JSONL、缓存、Skill受管派生和旧快照，失败沿同operation恢复；全通过才完成。新App启动不再依赖旧PG，不静默重新创建旧业务库。

当前没有执行以上任何真实切换；旧PG指纹、用户目录、凭据均未读取。原始微信／用户文件和供应商副本不由本地成功回执宣称已删。

## 10. 已验证与仍需验证

[实际约束探针](../../research/sqlite-constraint-results.md)在Electron 44.7.0 / Node 24.21.0 / SQLite 3.53.4上运行纯合成内存／自建临时库，覆盖代表FK／NULL／STRICT／部分唯一／延迟版本、typed引用、BigInt、Worker、busy与WAL。以结果文件实际组数为准，临时目录已清理。

目前11/11组通过，新增共享材料仅验证3用途／2来源及合成许可，不含quality等所有分支。故意FK违规时integrity_check仍可能ok，foreign_key_check能检出；正式结构检查必须分别运行，不用前者替代后者。

它没有执行94表全量DDL，没有证明全部材料类型、全部业务资格、CLI协议、崩溃恢复或实际性能。后续负载至少覆盖不同消息／记忆数量、混合写入／读取／清理，记录延迟、事件循环阻塞、busy及页空间，与同规模基线比较；指标须在完整实现验证中报告，不凭微探针宣布优化。

先审逐表必要性、基础范围与条件项，再讨论Q43；之后才收敛正式schema/spec与实现任务。所有前项逻辑决定保持，不因本项选择撤销隐私、手动发送或Skill原目录边界。
