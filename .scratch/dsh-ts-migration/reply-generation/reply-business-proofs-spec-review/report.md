# B5-01／02／03 Spec 独立审查

新增确认 finding：0。缺／部分实现、范围扩张、看似实现但错误三类均无确认项。只收窄业务证据，不签 App、整05、24回退、25对照或最终切换。

固定base `8dc8623db2532de354b0ad3ba314e9d92741a244`／tree `00aa5b61327c9156dfaf6dff4c01e68a4a6860f7`。未合入WIP不伪称三点提交差异。93输入、134项静态SHA／字节关联均匹配，含执行源、补丁还原、关键依赖及raw/public。锁DSH `0.2.1-rc.2`／官方 `687f282e8625c6b8d11ff58211a90524be2e4317`；归档无.git，提交关联沿既有锁证据，本轮核官方源码与安装metadata。

B5-01 `reply-background-public-acceptance/background-public.test.mjs:104` 符合05:18／20“晚结果不保存，真实调用仍按规则记账”：同联系人背景、两依据、公开与PG复读、幂等、失效晚响应409／候选0及实际记账相称。原1/1，最终本机HTTP2、累计4、vendor0。全表恒2是错误夹具断言，unknown未删除／改写／冒充HTTP；原graceful=false保留，显式stopped／exit／连接0另有证明。

B5-02 `reply-arbitration-handover-acceptance/candidate/reply-arbitration-handover.test.mjs:46` 符合05:21“保持前台优先及总并发”：真实两侧SDK、原ReplyService与PG许可同Host，B2先等后登记TS，物理B1→TS→B2／max1；按permit_id关联两层attempt。Python合成claim／测试guard／固定deadline仅证明聚焦仲裁，未证明完整Worker整理资格。

B5-03 同候选`:68` 符合05:22／39“保留新增／编辑／删除决定”：同库正常TS→Python→TS保留原UUID、编辑、显选与删除，复读HTTP增量0。原合跑2/2、最终本机HTTP5／vendor0；早期累计保留24–25，不冒称产品自然红。

interactive补充只绑定当前新UUID的两条unknown→layered_memory／organize_memory，不回填历史或升级为已观测HTTP。按原05／25边界保留全部96及阈值，不加本窄目标门槛。

本轮测试、PG、HTTP、SDK、模型、App、微信、安装及Git写入均0；仅新增本审查目录文件，未读真实.env／凭据／聊天。输入SHA详见 `input-sha-audit.json`，完整边界见 `handoff.md`。
