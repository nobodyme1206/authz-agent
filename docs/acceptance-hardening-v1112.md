# 1.1.12 停止记录：供应商推理占用输出预算

冻结提交 `4c265f3`，分析器 `authz-java-1.1.12`，计划十八项。实际进入四项后主动停止，SDK 报告合计 137,862 Token；取消任务按完整预算预留后占用 174,822 Token。首次结果见本地 `artifacts/hardening-v1112-manifest*`，不得用下一版本结果替换。

系统规则和工具声明已保留，实际提交请求携带一个工具，最大输出也是 4,096，未再使用 required。但 N1 的两次输出都以 length 结束；SDK 记录每次 output=4,096，其中 reasoning=2,643/2,667，剩余空间不足以输出完整参数。说明 Pi thinkingLevel=off 没有禁用当前供应商默认推理。

当前端点确认为 api.deepseek.com。官方 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 与 [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/) 指定通过 thinking.type=disabled 关闭思考模式，推理与工具参数共享输出预算。1.1.13 为官方端点显式发送该开关，其他兼容端点保持原参数；不提高输出上限。

本轮没有完成语义验收，不以输出截断当作项目授权结论；未执行项继续保留。
