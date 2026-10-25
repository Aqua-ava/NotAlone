# 小ACK与客户端：独立运行补充

代码结论仍为`undetermined`，只绑定输入v1；最终提交尚未提供。静态可登记规格偏离仍为0项；本轮有效独立接口探针9/9通过，不批准总体性能、25或26。原静态报告、binding及43份artifact摘要保持冻结，未覆盖。

## 有效结果

输入manifest SHA256为`3513144b9dd7e53825a52c262a3df7ce631616928e0d93ff8b267b81c5c86deb`。`execution-v3/`才是有效冻结运行：基线ACK正向断言失败，exit2、1/1失败；候选同断言及另外8项通过，exit0、9/9，合计2.18秒。三入口从冻结命名空间实际装载的SHA均有强制断言；其余源码按捕获提交及闭包冻结。源码／依赖／探针／运行器／raw与公开副本dualSHA见`attempt-bindings.json`和`prepared-binding-v3.json`。

| 合同 | 观测与对应冻结源码 |
| --- | --- |
| 小ACK精确opt-in、非读取成功 | 69字节，仅`accepted/contact_id`；无完整状态读取、事件或成功时间推断。`backend-ts/src/pure-ts-sync.ts:80–89`。附加／重复参数、其他命令ACK、身份注入、非法body拒绝且不登记；错误／缺失owner不返回成功。 |
| 旧无参POST／GET兼容 | 两者完整状态一致，337条覆盖、7条incomplete保留，100120字节。`pure-ts-sync.ts:77,90–91`。 |
| 原16KB／2秒限制 | 实际`JsonClient`拒绝超限响应为`response_too_large`；阻塞回执约2004ms触发原网络期限，之后先重试clear再登记最新选择，代际未擅改。`desktop/src/main/sync/priority.ts:59–65`及`desktop/src/main/backend/json-client.ts:123–153,207–213`。 |
| 串行、代际和停止 | 初始clear在途选择B再C，只null→C，最大并发1；目录外选择只null。代际变化取消旧请求，新代际先null再C；错代际回执不确认clear；显式关闭只null。`priority.ts:24–70`。 |

接口范围、错误语义及停止原条款为`spec.md:28,41,53–54,62–65`、`architecture/current/core-flows.md:98`及`issues/25-integrated-acceptance.md:21–25`。未新增产品验收阈值：2004ms只是观察值，仍由2000ms原配置与真实取消行为作合同判断。

## 原始失败与证据资格

`execution-v1/`是探针解析器误拦已装pg包相对导入导致的编译失败，未执行业务。修复解析器后的`execution-v2/`漏拦esbuild的`<stdin>`，基线错误通过；运行器将比较判failed，不可用作冻结产品证据。随后补三入口实际冻结装载SHA强断言，v3两臂重新执行才得到有效RED／GREEN。三轮原始输出、原探针／运行器和摘要均保留；没有隐藏失败或只重跑输臂。

## 数据与运行边界

只用合成HTTP及显式账号／增量状态替身，未连接PG、执行模型、启动DSH或产品宿主／App／微信；未访问原资料／真实配置，不改产品／测试／用户三文件／index／Git／任务状态。该替身证明接口不能注入owner和账号，不证明实际数据库授权、owner+contact隔离、读取历史或持久删除通过；不替代其他原门禁。

根已收到直接释放窗口通知。`cleanup.json`确认probe与esbuild服务进程0、数据库创建／连接0、产品宿主0、自有临时目录0。原始log已逐字移到仓库外root指定的独立0700子目录，文件0600，六份SHA均未变；公开副本去本机路径，私有定位文件不stage。只读输入及原静态43份摘要前后均相等。

总体仍未批准：HTTP RED，正式启动／RSS、最终回复96及最终实际App／微信待完成。输出／费用豁免，1056／120语义`deferred_by_user`，其余原合同保留。下一步仅待根给同字节最终提交或新delta，再做最终绑定判断。
