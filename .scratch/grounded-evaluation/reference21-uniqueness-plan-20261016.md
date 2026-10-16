# 原公开21窗：显式归属来源提示合同

## 目标与范围

验证[已完成离线接线的提示](../grounded-ambiguity-check-plan/implementation-result-20261016.md)是否改善实际模型的归属核对。原21窗／原顺序A01—A19、B01／B02、28必需＋1可选、已审source-fidelity-v2参考和全部输入不变。原A05失败、旧运行与关闭余额不改、不拼成绩；新提示不是旧响应的修复程序。

## 唯一新合同

| 字段 | 固定值 |
| --- | --- |
| execution_plan | `reference21-grounded-v4-source-v2-uniqueness-v-off-forced` |
| mode／stage／owned kind | `deepseek_bounded_reference21_v4_source_v2_uniqueness`／`reference21-v4-source-v2-uniqueness`／`reference21-v4-uniqueness` |
| extraction／E提示 | `grounded-v4`／`reference-uniqueness-v1`，实际system必须为已审新增通则，不回退默认 |
| reference／V | `source-fidelity-v2`／既有`legacy-v4`严格四槽，V提示`public-author-quote-v1` |
| provider／阶段策略 | 既有`deepseek-phase-split-v1`；E思考max、省略tool_choice；V关闭思考并强制原具名工具 |
| endpoint／model | 仅`https://api.deepseek.com/chat/completions`／`deepseek-flash`，实际请求与响应身份均核 |
| 请求／重试 | 新独立cap42、零SDK重试；一次持久领取后一次授权凭据加载，旧余额永久关闭 |
| 时间 | 从prepare绝对4小时，工作14380秒；每调用及RAW／FULL各600秒，HTTP读取300秒，较早截止优先 |

仅复用现有reference21-v4-public helper／adapter factory／记录器／分阶段审核／owned回收，新增封闭profile选择，不增runner、harness、供应商或验证mode。E提示选择须穿透合同快照、实际runtime与每次发送前检查；新身份不能使用旧默认E，旧身份不能混入新E。原v2／v3／v4默认及所有旧profile行为保持。

领取和凭据之前，核原21无受控source_snapshots／message_snapshot，message_type与text_representation均unknown；真实或混合可信来源拒绝，不补造来源。V额外proof包括null仍先封存原件再严格失败，不剥字段或追加调用。typed_evaluated=false、typed_credit=false，不补verification_program。

## 实施与验证

沿已授权接缝先红后绿：新E system与原schema／输入到实际SDK请求一致；旧默认字节保持；错配E profile／plan／V／范围／cap／源快照在预算、凭据、传输之前拒绝。完整Mock为21E＋19V＝40／42并到B02、关闭；另重放原A05无码标签仍由完整语义审查停止，不能用提示选择改写旧参数或救分。新增的计划、实施、提示规格及实际来源进入新freeze，旧freeze仅为已关闭历史。

最小后相关回归和类型通过，再完成Standards／Spec审查、本地提交及公开扫描。Root最终核新freeze、旧场关闭、新registry不存在、绑定既有授权后才唯一启动；准备不创建真实预算或请求，不自动后继。真实运行串行于当前桌面焦点验收，避免协调干扰。

## 结果解释与停止

RAW先封存并独立审查，再由Root做FULL，回执严格绑定。主集≥15只按同场实际完成的A01—A16窗口计，仍须假事0、记错人0、一般错误≤1及安全条件；A17—A19、核心B01／B02的3＋2必需分列，不借旧场或命题数凑门槛。私人严格6／12、可选2／6及留出保持独立，未授权资料不进入本合同。

一般错误继续；安全、语义unknown、结构／技术／来源／冻结漂移或记录错误立即硬停并关闭，未知请求不补发、不退款，不反复调词重抽到通过。Root核事件／摘要／SQL／审核收据及自有进程组退出，关闭失败如实close_unknown。没有业务PG、真实聊天、GUI、ECNU、外部消息或远端Git；不改生产空放行表、Gold或三票状态。完整140另行固定并评审V配对，本场不自动注册或启动它。
