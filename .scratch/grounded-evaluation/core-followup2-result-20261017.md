# 核心固定集追加第二场：关闭，完整契约5/6

本场沿[最多56次追加方案](../memory-core-claim-retention/fixed-repair-followup-decision-20261016.md)，在第一场关闭、自然日核验修复及独立两轴通过后启用。同一固定六窗、target、Gold、顺序及模型配置保持；新独立四窗仍未读取或运行。

## 实际运行与关闭

- run：`6b14e798-95f9-4e65-b7a0-7e7eccc5ff50`；隔离源码`bc96de35be4a3fd9d4d26e5ba50a5a4d5389849c`。
- 官方DeepSeek Flash；E=`grounded-v2`、V=`legacy-v4`，两阶段thinking enabled／effort max、temperature 0、tool_choice省略、SDK timeout 300秒、max_retries 0。300秒是SDK I/O配置，不能当整请求墙钟保证。
- 独立cap12，实际预约12、E/V各6、请求及HTTP200各12，无重试／fallback／capture缺口；耗时3454.7908882500196秒，正常关闭12/12。
- 六次RAW均先封存再开放对应FULL；run／phase／case／nonce／view SHA均匹配，十二份审核时钟均在600秒内，最长118.364209秒；全部在冻结结束时间前完成。

## 完整候选审核

| 窗口 | RAW行／通过字段 | 必需raw | 接受 | 完整 | FULL结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| W01 | 3／42 | 1 | 1 | 1 | 未来安排与有据请求完整 |
| W02 | 5／70 | 1 | 1 | 1 | 作者观点与全部正确额外候选保留 |
| W03 | 2／28 | 1 | 1 | 0 | 习惯正确，额外完整问答被V不必要降级 |
| W04 | 1／14 | 1 | 1 | 1 | 当前状态与观察边界完整 |
| W05 | 1／14 | 1 | 1 | 1 | 模糊未来安排的顺序与双null完整 |
| W06 | 2／28 | 1 | 1 | 1 | 自然日日期及额外候选通过本次实际核验 |
| 合计 | 14／196 | 6/6 | 6/6 | 5/6 | safe5、general_error1 |

全部E字段、正文和正确额外候选保留；正文损失、语义假事、错人、错误／歧义auto及审核未知均0。实际V为supported13、uncertain1；唯一问题是W03的完整未来问答extra被追加`semantic:pragmatics`。其plan表达在完整问答下仍合理，独立审核同意记不必要降级；不把四槽响应当模型内部原因的证明。严格FULL仍为5/6，`quality_certified=false`，核心票不能关闭，新留出不能启用。

最终隔离评测去向为正确auto1、pending13，无业务采纳。原通用dummy expected=pending使W03机械诊断false_fact1／passed=false，原记录保持；它不等于本次Gold下的假事或错误auto。14份维度依据仍为旧version1、source_bound=false、semantic_basis=null，不计类型化依据或逐维度放行通过。

## 独立闭账与后继

独立审计复核72条事件顺序及canonical payload SHA、十二份wire→adapter工具调用、实际提示与schema合同、全部RAW／FULL及正确extras。76份源文件、8个安装包、2份输入摘要均一致；关闭时HEAD正确且Git干净。exact-run registry为closed12/12，claimed及closed标记存在；当前自有PID／PPID／PGID匹配0，in-flight锁无持有者，126份既有证据文件／目录符合0600／0700。

审计只对凭据作stat，运行loader收据为reads1／secret_persisted=false；无业务库或桌面操作。保存的脱敏JSON不能重建原HTTP字节SHA；start未保存原始PPID／PGID，不能认证完整历史进程谱系。私有独立闭账收据SHA256：`cdaec34022f2b7816d3ec67f4ff1fd6a8c5e27eff3b1ddbd4d9c230b8d3fd901`。该审计明确释放本场源码冻结，未放行质量。

追加56次累计已用24，余32为最多两个新固定场各cap12及唯一新四窗cap8。下一场只能在[当前判断与未来安排的提取指导续修](../memory-core-claim-retention/future-judgment-followup-spec-20261017.md)实际修复、检查及独立两轴通过后重新冻结，并只运行一次；不得原样重跑、借旧余额或改变样本／Gold。原核心票仍claimed；本报告不作为公开140、指代或第三张逐维度票的质量分母。
