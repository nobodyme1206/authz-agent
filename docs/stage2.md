# Stage 2：实际授权检查提取

## 使用与输入

在项目的“实际授权”页选择已终止的 Stage 1 任务。来源可以为 partial；选择 1—10 个 API 后分别创建任务，单 Worker 顺序执行。默认选择一个，不会自动发起全项目分析。每个任务独立使用模型预算。

```json
{"kind":"stage2_analyze","snapshot_id":"snap-...","options":{"stage1_run_id":"run-...","api_id":"api-..."}}
```

来源任务必须终止，API 必须存在于同一快照的已校验记录中。API 数据与索引详情在创建任务时复制并计算内容哈希，后续不依赖可变的来源查询。Stage 2 的字段引用只能来自这份固定输入，采用 body:userId 等形式；新发现的字段作为补查问题保留，不改写 Stage 1。

## 分析方式

java-parser 3.0.1 构建 Java CST，扩展方法返回类型、参数、局部变量、注入关系、继承及 Mapper 导航。默认展开六层、最多 200 个方法节点；重载或多实现不能唯一确定时不任意选取。外部类、复杂链式调用、运行时代理和反射可能保留未知。导航只表示源码关联，不证明检查阻止了操作。

Mapper XML 使用 saxes 6.0.0 解析 namespace、statement 和动态标签、include 引用，保留源码行号。不获取外部 DTD，拒绝内部实体声明，不执行 OGNL/SQL。代码生成模板记录为 code_template_not_runtime_mapper，不当作运行时 Mapper；全仓诊断保留在详情，不机械地全部变成当前 API 的阻断问题。

Mapper 的 Select/Insert/Update/Delete 及 Provider 注解按接口完整名称、方法名和源码位置登记；Provider 只导航到源码，不执行生成器。复杂动态 SQL 不被化简为无条件范围约束。语义参考 [MyBatis 动态 SQL](https://mybatis.org/mybatis-3/dynamic-sql.html)、[Shiro 授权](https://shiro.apache.org/authorization.html) 和 [MyBatis-Plus 租户插件](https://baomidou.com/en/plugins/tenant/)，具体效果仍核对被测快照和配置。

程序提供候选调用、条件、CRUD、SQL、权限注解和静态控制项；Pi 阅读实际源码，理解主体、资源、分支与拒绝效果。授权语义不是 JSON Schema 或调用图能够证明的，必须结合测试与人工核对。

源码常量确定为 false 的分支单独登记，不作为有效检查。条件受数据库数据、部署配置或未知分支影响时，必须在 conditions 和 unresolved 中说明。普通筛选、空值校验、客户端声称的旧值不得被改写为请求者已有权限。

## Pi 工具与输出

工具只有后端文件列表、最多 100 行读取、文字搜索、符号定位、调用导航、SQL/片段读取、固定字段查询、相关框架源码集中读取和结构化提交。没有 Shell、写源码、任意联网、仓库扩展、前端政策或漏洞答案工具。

get_security_context 按实际类/方法和静态路由声明返回 Shiro、JWT、注解 advisor 及租户配置的原始片段，不直接给出授权结论。read/get_sql/security_context 返回的实际行范围登记为证据；search 的短匹配不能独立作为阅读证明。

阅读结果附带 f1 等文件短引用，Agent 可在提交证据中使用，程序展开为快照相对路径后才保存。这是会话内部的 Token 优化，公共证据格式没有改变。

详情分别保存程序导航读取和 agent_observed 工具实际阅读范围；程序提供的 CRUD 候选行不能单独作为模型已读证明。继续任务复用实际阅读记录；早期检查点移除程序候选的初始记录后再恢复阅读证明。验收脚本同样排除这些程序记录。

模型提交操作、检查、条件、必要映射和未知项，程序分配操作/检查编号并校验引用。提交工具内部的 kind 与 scope_source 用于区分认证、关系、可信范围、客户端筛选和普通观察，不进入公共核心数据；请求筛选和存在性校验保存在详情，不能成为授权检查。正式操作和检查均必须有已读证据。不允许把已知关闭分支作为有效检查。相邻/重叠的实际读取区间可联合支撑一条证据，存在未读间隙则拒绝。可选的未生效候选若缺少完整阅读证据，仅在详情记录未采纳原因，不影响已经合法的核心提交。接口级身份检查使用 fields: []。裸字段名称仅在唯一或各传输位置明确对应同一绑定证据时规范化为完整引用，否则拒绝。

单操作使用 operation；多操作使用 operations，检查仅约束部分操作时通过 operation_ids 关联。公共 envelope 和 Stage 2 核心数据继续遵守 v0.4，不添加核心必填字段。

## 预算与异常

| 部署配置 | 默认值 |
|---|---:|
| STAGE2_MAX_TURNS | 12 |
| STAGE2_MAX_TOOLS | 30 |
| STAGE2_MAX_OUTPUT_TOKENS | 4096 |
| STAGE2_TOKEN_BUDGET | 60000 |
| STAGE2_MODEL_TIMEOUT_SECONDS | 180 |
| STAGE2_TIMEOUT_SECONDS | 300 |
| STAGE2_CALL_DEPTH | 6 |
| STAGE2_CALL_NODES | 200 |

按 SDK 报告累计（包括 cacheRead），不把 SDK 占位价格当费用。达到限制停止后续模型请求；在途最终回复仍可验证保存，不因为已付费的回复刚越过预算而丢弃有效提交。若最终提交无效且预算已尽，则停止，不自动重试收费请求。

第 4 轮回复、累计达到 30,000 Token／预算的一半（取较低值），或仅余两个工具名额时，切换为仅允许 submit_authorization，并通过 Pi steering 明确要求用已读证据收束；这不是额外的自动重试。仍须遵守总回复、Token、工具和时间限制。模型可能在收束前已申请并行读取，或生成不可执行的调用；因此收束不能保证所有任务成功。

没有模型、认证失败、用量缺失、超时、输出截断或预算耗尽均明确记录。程序仅保存能确定的操作候选，并声明语义未完成；这类 checks: [] 不能解释为无鉴权。没有有效操作成果时 result 返回 409，不生成模拟成功。

## 存储、接口与恢复

迁移 0003_stage2 在同一迁移事务中新增 stage2_states，保存固定输入、哈希、版本、检查点和详情，保留批次一、二数据。

- POST /api/jobs：创建单 API 的 stage2_analyze。
- GET /api/jobs?kind=stage1_extract：先按类型筛选再返回最近 100 项，避免 Stage 2 任务挤掉来源列表。
- GET /api/jobs/{id}：运行状态、轻量分析进度和用量。
- GET /api/jobs/{id}/analysis：固定输入、调用关系、候选、静态控制、实际读取和诊断。
- GET /api/jobs/{id}/result：单 API 的 v0.4 Stage 2 结果。
- 原有取消、SSE、源码证据和历史任务接口继续适用。
- 内部 stage2/context 和 stage2/checkpoints 接口必须通过 Worker token、启动身份和任务所有权校验，单检查点上限 1 MiB。

Controller/Service 导航完成后保存程序检查点；每次源码读取及模型最终提交保存检查点。取消、重启或失败保留有效结果并标记 partial，不自动恢复模型调用。

显式继续时增加 options.base_run_id，创建新任务；来源 Stage 2 必须终止且快照、输入哈希、分析器版本相同。已读范围与有效结果可复用，新的会话和用量独立保存。历史结果不改写。

当前分析器为 authz-java-1.0.0。源码未知和相关 Stage 1 未知保守保留；有语义缺口时 partial，不以任务正常完成代替分析完整，也不作漏洞判断。
