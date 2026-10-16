# Stage 1：Java Spring MVC 接口与字段提取

## 结果契约

继续使用 v0.4。公共 envelope、`data.apis` 和字段对象均不增加核心必填字段。兼容增加 `method: "ANY"`，准确表达 Spring 源码未限定 HTTP 方法；不将其改写为 GET 或伪造八条具体方法。已确认的基线原文保留在 approved-v0.4.txt，本文件记录扩展。

每个 API 使用 `api_id / method / path / file / line / request_fields / unresolved`。每个字段使用 `name / location / type`，按需附加 `note / evidence`。位置与证据均关联固定快照相对路径；程序分配元数据与 API 编号，模型不能改写路由与源码版本。

稳定编号是源码版本、具体 Controller 文件和类、入口签名、路由、方法、路由条件的 SHA-256 前 24 个十六进制字符，前缀 api-。不同 Controller 或服务中的同名路径不会合并。行号指向入口方法声明；继承入口可位于父类文件，具体 Controller 另存任务索引。

## 实现与范围

- Node 24 Worker 使用锁定版本 java-parser 3.0.1 构建 CST 与 Java 符号索引，不执行 javac、Maven、Spring 或被测项目脚本。
- 索引快照中 src/main 下的 Java 文件，逐文件保存 parsed / failed 记录。include_paths 限定 Controller 扫描范围，相关 DTO、常量和 helper 仍可读取同一快照中的生产源码。没有后端源码、解析失败或动态路由不能静默消失。
- 支持常见 Spring MVC 映射、数组路径与方法、常量、接口/父类映射、常见 DTO 与字段注解、继承、嵌套、集合、Map/JSONObject 常量键、Servlet 参数/Header/文件读取和两层方法传播。
- 方法条件的组合依据 Spring 的 RequestMethodsRequestCondition.combine 语义；[官方实现](https://github.com/spring-projects/spring-framework/blob/6.1.x/spring-webmvc/src/main/java/org/springframework/web/servlet/mvc/condition/RequestMethodsRequestCondition.java)采用方法集合并集。路由条件单独保存，部署 context-path 和网关路径不拼入 Controller 路径。
- 嵌套名称如 profile.id，集合元素如 items[].id。`$` 表示没有属性名的整个请求体。DTO 展开最多六层、每 API 最多 2,000 个字段；截断与循环引用均记录 unresolved。
- Spring 请求参数在适用情况下可来自 query 或 form，结果保留两种位置并说明，不将两个记录解释为必须同时提供两次。type 表示绑定/读取类型的归一化值，未知为 null；CSV 等附加说明必须有源码依据。
- 首版不是运行时注册清单，不承诺启用某一 profile 后的可达性；外部依赖类型、反射、自定义绑定、复杂泛型/继承及超出追踪深度的流程可能保持 partial。它不能替代部署后的接口枚举。

## 任务接口

`POST /api/jobs` 保留旧 `{snapshot_id, file}` Probe 用法；Stage 1 使用：

```json
{"kind":"stage1_extract","snapshot_id":"snap-...","options":{"include_paths":["jeecg-boot"],"enrich":true}}
```

include_paths 必须是快照内目录，省略为全部后端。enrich 默认为 true。继续补全时增加 options.base_run_id，必须是终止的 Stage 1 任务、同一快照、相同扫描目录与提取器版本，否则返回 409。

- `GET /api/jobs/{id}`：任务状态及 analysis 扫描元数据，包含文件记录、诊断、阶段进度、用量与预算停止原因。
- `GET /api/jobs/{id}/apis?q=&method=&unresolved=&page=1&limit=50`：分页 API 清单；limit 最大 200。
- `GET /api/jobs/{id}/apis/{api_id}`：核心 API 数据及 handler、路由条件、输入证据范围、补全采纳/拒绝信息。
- `GET /api/jobs/{id}/result`：v0.4 envelope，包括所有已校验 API；有检查点但未完整完成时返回 partial，没有可用结果时返回 409。
- 原有取消、SSE、源码证据接口继续适用；任务列表不内嵌大型 Stage 1 结果。

内部检查点提交使用 `/internal/jobs/{id}/stage1/checkpoints`，必须通过 token 与当前 Worker 启动身份检查。每批不超过 50 条 API / 2 MiB，程序校验编号、字段结构、重复项、路径、行号和版本后事务化写入。扫描级问题保存为任务元数据，不增加伪 API 或 core 必填字段。

## Pi 补全与预算

程序先保存全量确定性结果，再按文件、入口位置和路由排序补全疑难 API。每个 API 使用隔离会话，不把整仓代码一次性交给模型，不按已知漏洞优先排序。

工具只有文件列表、有限行读取、索引内文字搜索、符号定位及 submit_fields。读取最多返回 100 行；过长读取会截断并明确返回实际范围和 truncated，不将未读内容视为证据。模型不能加载仓库指令或扩展，不能使用 Shell、写源码或任意联网。

字段增量必须由 submit_fields 提交，包含已读取的源码证据。程序拒绝未读证据、超出已确认输入范围的证据和与确定性类型冲突的字段。模型新增动态键还必须通过 Controller 请求对象读取关系检查；局部服务端 Map 不能变成请求字段。首版对不能证明的跨文件、深层、嵌套动态新增采取保守拒绝，并保留未解析问题。说明或类型补充可按既有绑定校验后采纳，不等于该 API 的全部问题已经解决。

模型提出的 resolved 只作为 detail.enrichment_proposed_resolutions 留存，不会自动清除程序诊断。例如确认 Map 的容器类型为 object，不能证明它的动态子字段已完整恢复。这样会保留部分可进一步核查的问题，但不会用模型自述把不完整结果变成 completed。

默认预算与部署变量：

| 配置 | 默认值 |
|---|---:|
| STAGE1_MAX_ENRICH_APIS | 20 |
| STAGE1_MAX_TURNS | 6 |
| STAGE1_MAX_TOOLS | 12 |
| STAGE1_API_TIMEOUT_SECONDS | 120 |
| STAGE1_MAX_OUTPUT_TOKENS | 4096 |
| STAGE1_TOKEN_BUDGET | 100000 |
| STAGE1_TIMEOUT_SECONDS | 1800 |

不自动重试收费调用。按 SDK 报告用量累计，模型回复后检查 Token 预算，限制后续调用；SDK 中占位为零的价格不代表服务账单。模型异常、用量缺失、预算耗尽均保留程序结果与停止原因。仅修改 .env 的部署值后须重新创建 Worker。

## 持久化与恢复

数据库启动执行显式迁移 0002_stage1：事务内为旧 jobs 增加 options，登记 schema_migrations，并创建 stage1_states / stage1_apis。迁移可重复执行，不重建已有数据。升级前如需完整回滚，应保留数据库备份与旧镜像；不提供会删除研究数据的自动降级。

每个 Controller 的结果和每个 API 的补全均保存检查点。大型结果不使用 Probe 的 64 KiB 限制。数据库保存成果和事件，runs 卷保存脱敏会话与结果副本。取消、失败及重启保留有效结果，强制标记 partial；没有 API 且索引尚未完成时，结果暂不可用。

已完成、取消或失败的任务不会自动恢复收费调用。用户主动继续时创建新任务：重新建立源码索引，复用兼容检查点的字段结果，并只将仍未解析的 API 送入补全。提取器版本改变后不能复用旧检查点，需要重新提取。
