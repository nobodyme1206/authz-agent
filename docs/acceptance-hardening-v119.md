# 1.1.9 冻结复验与主动停止

冻结提交 `39008f0`，分析器 `authz-java-1.1.9`，批次 `hardening-1fb97a9842b840efa02f14ab95e41b30`。源码、人工预期、预算和顺序保持固定，未将预期答案输入模型。

Docker Worker 75 项、API 与独立 PostgreSQL 各 20 项通过，Web 构建通过。真实执行暴露 SDK 输出截断没有进入程序纠错路径，且部分接口在纠错后未调用提交工具。本轮主动停止，未执行后续十项；所有首次失败保留，不宣称通过。

| 样本 | 首次任务 | 状态 | SDK Token |
|---|---|---|---:|
| N1 | run-ee73310370254d11a5faeefd6c0f2950 | failed：预算预留不足 | 34,938 |
| N5 | run-49ab3dff54d34e87b1736835c39066c9 | failed：缺少有效提交 | 38,136 |
| role/add | run-f9d0abea4c394690acc805b4849cafe3 | failed：预算预留不足 | 32,021 |
| role/edit | run-82ae880f7df74eb68b0f58d40be7055b | completed / partial | 32,490 |
| role/listByTenant | run-9746d398583448f28519977a3305d3f5 | failed：缺少有效提交 | 37,220 |
| role/list | run-7c0a90e7717e4f7dab046bc3a933beeb | failed：缺少有效提交 | 47,345 |
| tenant/list | run-2754cb1716144e6f83beb5fa97dd5811 | failed：缺少有效提交 | 48,676 |
| queryMyDeptTreeList | 见原始 attempts | 主动取消 | 8,430 |

SDK 已报告合计 **279,256 Token**；取消任务可能有未完整回传的在途用量，不能将其当作精确账单。后续预算对该取消任务按完整 60,000 Token 预留，故本轮合计占用 **330,826 Token** 的保守额度。

## 根因与后续修正

Pi SDK 1.3.0 的 `clampMaxTokensToContext` 按 SDK 上下文估算与 4,096 安全余量自动缩小输出。模型配置最大输出 4,096 不等于每次实际请求都能获得 4,096。N1 截断提交被 SDK 拒绝执行，程序 submit_authorization 的 catch 未运行，旧精简纠错路径没有覆盖该情形。

1.1.10 因此加入 SDK 自身上下文估算、有界源码视图、SDK 级拒绝纠错和实际输出配额记录。完整报告与转录仍保留；压缩不允许引用未交付给模型的证据，不放宽正式检查校验。新版本的协议测试和真实成绩必须单独记录，不能替换本轮结果。

本轮没有完成八个语义对照，不能沿用历史 8/8 成绩；也不对任何案例输出漏洞或 Requirement 结论。
