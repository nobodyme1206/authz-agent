# Stage 2 1.1.8：提交稳定性与统一复验

公共格式保持 v0.4，范围仅基础设施、Stage 1 与 Stage 2。审查并保留工作区中有效的 Mapper 声明解释、检查点和测试修改；未将未提交的 1.1.7 视为已验收版本。

## 修正

- 取消初次任务只能读取源码包、第二轮必须提交的硬限制；初次与继续任务都可以定点补读。首选有界源码包，截断与未读方法、SQL 继续留在范围台账。
- 按实际输入、输出、工具新增上下文及完整最大输出预算，提前预留最终提交。轮次、工具或预算临近限制时进入仅提交状态；逐请求保存预算估算历史。不提高原预算，也不将规划估算表述为精确计费上限。
- 核心提交与可选审计笔记分离；具体错误及可用操作引用作为修正反馈，最多一次修正，不重复整份参数，不放宽证据及引用校验。
- 多资源效果、主辅操作关系、比较与拒绝证据、数据库原值与请求旧值的既有回归继续保留；不会将目标成员关系改写为请求者 owner 检查。
- 已读且无冲突的 Mapper tenantLine 常量声明保存为详情，注明插件适用前提；动态声明或冲突继续保留未知。
- 撤掉按部署关键词自动移除未知的逻辑。显式未知分类仍需源码依据，关键调用及机制未知由程序强制保留。
- 页面说明任务正常结束不等于语义验收通过。API、Worker 和页面同步版本；旧结果仍可读，不跨分析器版本继续检查点。

## 验证策略

所有构建与自动化测试在 Docker 内执行。新增源码包后定点补读、预算收敛及关键词不能清除未知的回归。协议 fixture 与历史重放均不作为真实模型成绩。

冻结版本后按 N1、N5、其余八个 JeecgBoot API、八个语义对照执行一次真实复验。每任务限额仍为 60,000 Token、12 轮、30 次工具调用、180 秒模型时间、300 秒任务时间。连续两次提交预算失败或全局模型故障时停止；不自动重试、不替换失败、不混算历史任务。

真实语义成绩及未执行项另存验收报告。本版本不实现 Stage 3/4，不读取漏洞报告作为模型输入。

## Docker regression before freeze

Worker: 70/70; API: 20/20; isolated PostgreSQL: 20/20. TypeScript check and Web production build passed. One obsolete fixture assertion for the removed submit-on-reply-two restriction was updated; focused-read availability has an independent SDK fixture. Live model acceptance is separate.
