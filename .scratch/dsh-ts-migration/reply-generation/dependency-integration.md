# 05 检索依赖装配记录

2026-10-24，主会话按05请求固定 `@huggingface/tokenizers@0.2.0` 与 `onnxruntime-node@1.30.0`。本记录仅证明依赖可用，不证明检索等价。

- 查证[Hugging Face 官方项目](https://github.com/huggingface/tokenizers.js/)及[ONNX Runtime 官方 Node 接口](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)，并读取两个精确版本的registry repository、scripts及dist.integrity。
- tokenizers integrity：`sha512-LidMHe1FpcSYH4vcSjXooda34pC0M8m1gmDOv7SQi6Iv+ib1zX7J3sHBCC9/3FPCkn2k1b55FneVqMRxrr99pg==`。
- onnxruntime-node integrity：`sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==`。
- 执行精确版本 `pnpm add --save-exact --ignore-scripts --no-optional`；会话恢复时原PTY已消失，不能引用缺失结束日志为安装证据。随后核对package/lock实际落盘并运行下面复验。
- 固定Node24/pnpm11.25.0：`pnpm install --offline --frozen-lockfile --ignore-scripts --no-optional` 成功；Node ESM实际导入Tokenizer和onnxruntime-node成功，原生Tensor构造成功，ONNX版本1.30.0。
- 未执行postinstall，不引入运行时自动下载；实际模型权重、token IDs、池化及数值排序对照仍由05检索验证负责。Tensor构造不代表模型推理通过，依赖文档不代表原Python分词等价。

本步骤无真实聊天、凭据、模型API调用、App/微信操作或业务库修改。未打包、推送；同snapshot本地推理及公开回复集成尚待验收。
