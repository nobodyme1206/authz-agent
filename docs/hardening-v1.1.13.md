# Stage 2 1.1.13：落实 DeepSeek 的非推理配置

继续使用用户配置的模型与端点，不提高 Token、上下文、轮次、工具或时间预算；公共格式仍为 v0.4。

对精确匹配 api.deepseek.com 的官方端点，在 SDK 最终请求中显式设置 thinking.type=disabled，使原本预期的非推理配置实际生效。其他兼容端点不自动添加供应商字段。依据：[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 与 [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。

新增 reasoning 独立用量记录，用于核对实际供应商行为；它已经包含于 output，不重复计入 totalTokens。继续保留实际最大输出、工具数量和真实请求参数记录，不记录密钥或请求头。

系统规则与工具声明保留、SDK 同源上下文估算、有界源码视图、字段来源校验、已读证据编号与唯一一次纠错继续生效。测试覆盖非官方相似域名不得收到专用参数，原 payload 不被修改。

前四轮 SDK 已报告 507,570 Token；对取消任务预留完整额度后，保守占用 596,100 Token。新的独立冻结轮与此前合计继续受 1,080,000 Token 规划额度限制。每次失败、取消、未知和未执行均单独记录，不拼接通过成绩。
