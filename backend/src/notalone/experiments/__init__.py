"""仅处理新建合成资料的独立实验，不进入产品默认装配（dev-only）。

本包只允许 experiments 内部模块、离线评测脚本与测试 import；生产 `notalone`
包不得依赖本包（ticket 07 解耦后生产侧 `from notalone.experiments` 为 0）。
`notalone-memory-evaluate`、`notalone-retrieval-evaluate` 两个 CLI 保留注册，
但只用于离线/开发评测，不进入产品装配。
"""
