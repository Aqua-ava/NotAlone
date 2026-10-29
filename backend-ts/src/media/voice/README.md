# 语音适配器（18）

`contracts.ts:VoiceResourcePort` 是03/19待认证渠道的窄接点：传入已固定的 HistorySource、ReadEligibility、单消息身份与取消信号；返回该稳定资源的独立预期长度/摘要、限长字节流，以及流结束后的完整读取/唯一归属证明。禁止任意SQL、外部路径、时间OR查找或取首条BLOB。未提供端口时只支持合法受管SILK的本地重转，真实提取不可用。

`VoiceMediaAdapter` 实现16的 `MediaAdapter`；只使用 `checkpoint/save`，复用同一文件发布、ActiveHolders及DeletionService。无新增迁移、删除域或缓存。新提取先证明完整复制并验证容器，再保存audio_source；WAV以parentFileId追溯原件。本地分支不调用VoiceResourcePort，仅读取16已核验的同消息当前文件。

新读取端口须返回与请求一致的`authority`、响应`signal`的流/结束检查，以及等待全部在途读取和原生句柄结算的`close()`。适配器先经`retainReader`登记，再读取；关闭失败保留共同holder，删除不可完成，原操作可重试释放。源支持档、消息范围及来源代次在打开前复验，不将“已请求取消”解释为已结算。

支持矩阵：腾讯 `0x02 + #!SILK_V3`；小端有符号长度1–1250字节，至少3包，精确EOF或末尾唯一-1终止。标准无腾讯前缀、未知变体、零包、半帧、其他负长度拒绝；不增删前缀。最大输入1MiB、600包，按每包最多5×20ms限制预计PCM至2,880,000字节；输出固定24kHz/单声道/s16le，标准44字节WAV。整包截短可能仍通过结构检查，因此完整复制证明必须独立存在；不以解码器duration证明时长或完整性。当前未认证消息时长单位，不进行猜测性时长比对。

WASM放在可终止Worker，10秒时限，取消/退出等待终止完成；输入、预计及实际输出均有界。Worker的JS heap限制不被当作WASM内存硬上限。实际固定依赖为silk-wasm 3.7.1，实际执行的绝对CJS入口和相邻WASM资产在Worker加载前按固定SHA256复核；缺失/变化明确组件不可用，不下载补齐。全部原始告知在notices/，随backend-ts/src复制进入受管后台。实际验证结果见本票Answer。

公共宿主最小接点：从`media/voice/index.ts`导入`createVoiceMediaAdapter(source?: VoiceResourcePort): MediaAdapter`，把默认工厂结果加入现有adapters。默认仅audio_conversion，extract=false；不改现有holders/deletion注册，不加工具或HTTP路径。本地输入除服务前后文件身份核验外，适配器读出的实际字节还必须匹配受管元数据的expectedBytes/expectedSha256。
