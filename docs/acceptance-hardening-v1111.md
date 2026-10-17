# 1.1.11 首项停止：供应商工具选择限制

冻结提交 `4f5b743`，分析器 `authz-java-1.1.11`。Docker Worker 78 项、API 与 PostgreSQL 各 20 项通过。真实复验只执行首项 N1，任务 `run-5d3b2e3c7d4847659c0575205aa31608`，SDK 用量 8,220 Token，状态 failed / model_interface_incompatible；其余十七项未执行。

本轮压缩请求确实保留系统规则和一个提交工具，最大输出为 4,096，修正了上轮声明丢失。但供应商返回 `Thinking mode does not support this tool_choice`，拒绝 required 工具选择。此时 Pi 的 thinkingLevel=off 并不能证明供应商已经禁用其默认 thinking 行为。

这是实现引入的额外工具选择限制，不是授权语义失败。停止后不在同轮改参数或重试。1.1.12 撤销 required，保持原有默认工具选择；仍要求真实工具提交并通过程序校验，不将普通文本解释为成功。系统规则、工具声明、SDK 输出配额与证据范围校验继续保留。
