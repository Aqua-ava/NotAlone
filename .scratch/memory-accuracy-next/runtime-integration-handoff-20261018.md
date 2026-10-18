# Runtime 集成交接

- 分支 `codex/memory-accuracy-integration-20261018`，工作树 `memory-bounded-runtime/NotAlone`；主仓未修改。
- 最新集成c1ff17bf（reference V保真5cd178a5），安全记录诊断061d27b4→5ca4cca5；core专用接线7565c327→7fe00b85。
- bounded双max独立配置688cad6e已完成；E/V均Pro max/omitted/8192、version5，原提示/Gold不变。
- bounded E 为 dependency-teaching-v2；V proof3 澄清既有三锚点合同，不改 compiler、schema、来源守卫或原15/Gold。
- 原 stage-v1/default/core/reference 配置保持独立；proof3 提示 SHA 有意变更，不声称旧字节不变。
- 合并验证：30 profile/注册测试及60共享入口/owned/fixture测试通过；7源码 mypy 通过；独立 Spec 冲突复核0问题。
- a98b317a 已有873项 extraction 单元测试通过；该结果不是当前集成全库认证。
- 最近真实 bounded 场 f0e64fae 已闭账4/30、4 HTTP200、零重试；首窗 P01 RAW/FULL 通过，依据实际交付1/15、正向1/7。
- P02 E 缺 dependency，V 引用了实际 candidate source IDs 外的声明消息；来源守卫正确拒绝，后13窗 unrun，不放宽守卫。
- 该场 capture gaps 为空，来源13表和隔离库残留0，进程退出，专用 key 已删除；生命周期仍 unrun。
- 六场13次已知请求、167未用额度关闭只是运行统计，不合并质量分母。
- 新场e00279a0已closed2/30，P01类别及期限错误未被V识别，potential bad_auto1而实际pending；后14unrun、正证0/7。
- 新场capture无缺失、进程59079/59157退出、13表及库残留0、key删除。P02依赖/三锚修正仍未真实验证。
- 只读对照不支持将失败归因v2或立即追加教学；不改Gold/映射、不复开预算。
- core 固定6场22c25347完整结束：RAW6/6、FULL3/6，安全错误0但一般错误3；留出4尚未启动或读取。
- core closed接线已集成；私有runner16合成检查与双审通过，细节见/tmp下core-profile-ready.md；等最终snapshot才新API。
- reference 原Pro16场28/32已闭账：审核14窗 safe8/general6；A15 V无法留正文而unknown，A16 unrun。
- reference teaching场已closed28/32，14审safe10/general4、完整9/18；A15 capture unknown/A16 unrun。结果59da7a93已集成。
- A05严格单消息理由修复1491348a→78241cc8已集成；84相关及2源码mypy通过，独立复核无产品问题。
- 统一913项全量已通过（35.679秒）；旧omitted断言按批准合同修正，14审核模块和独立增量Spec通过，无产品门/Gold变化。
- 同7bef5d1f三线已启动：core fixed6仍运行，W01独立FULL通过；heldout4仍封闭。reference retention closed10/32，结果31dd4599→5df0fa3d已集成。
- 生产放行表为空；task03第一AC未满足，State=claimed，goal=active。
- 后续仍须原15七正控/七轴及生命周期、core6/4、reference16质量验收；不得降低标准或修改Gold。
- 所有新场仅授权合成隔离数据；无新真实联系人、聊天发送、业务迁移、push或PR。
- 公开历史扫描仍有12项既有 engineering 本机路径记录；不能称全通过。
- 细节见 runtime-position-guide-20261018.md、core current-six-four-result 及 reference-pro16-result。
- 双max59项+兼容14项+6源码mypy通过；reference合并后51+30项、7源码mypy及独立Spec0问题。主bounded已关闭，core独立冻结场仍活跃。

- 最新bounded bcbbefa3已closed4/30，safe1/safety1、potential bad_auto1，正证1/7，13窗及生命周期unrun；资源清零。详见runtime-thinking-result-20261018.md。

- bounded依赖v3离线102项/8源码mypy及双审通过，仅thinking选择；后继须新冻结，不复用旧预算。reference独立Vmax version6仍离线验证；core前四窗FULL通过但未整场闭账。
