# 接口与开发约定

任务列表可使用 `GET /api/jobs?kind=stage1_extract`（同样支持 agent_probe、stage2_analyze）。类型筛选发生在最近 100 项截取之前。
Web 通过 `/api/*` 同源代理访问 FastAPI；不代理 `/internal/*`。跨站 Origin 的写请求被 Web 拒绝。API 容器本身没有宿主机公开端口。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | API、数据库、Worker 与模型配置状态 |
| GET | `/api/sources` | 允许目录中可登记的直接子目录 |
| POST | `/api/projects` | 登记 `{name, source}`，source 必须为允许目录中的直接子目录名 |
| GET | `/api/projects` | 项目列表 |
| GET | `/api/projects/{id}` | 项目与快照列表 |
| POST | `/api/projects/{id}/snapshots` | 复制源码并计算版本 |
| GET | `/api/snapshots/{id}` | 快照元数据 |
| GET | `/api/snapshots/{id}/files?prefix=&limit=100` | 文件列表与截断标识 |
| GET | `/api/snapshots/{id}/evidence?file=&start_line=1&end_line=20` | 带行号的代码片段 |
| POST | `/api/jobs` | 创建 `{snapshot_id, file}` 连通性任务，或指定 `kind: stage1_extract` |
| GET | `/api/jobs?project_id=` | 最近任务（最多100条） |
| GET | `/api/jobs/{id}` | 任务状态 |
| POST | `/api/jobs/{id}/cancel` | 取消任务 |
| GET | `/api/jobs/{id}/result` | Probe 成功结果，或 Stage 1 已校验结果；Stage 1 失败/取消但有检查点时可返回 partial，没有可用结果返回409 |
| GET | `/api/jobs/{id}/events?after=0` | SSE，事件名 `execution`，支持 Last-Event-ID |

Worker 内部接口以 `/internal` 开头，必须携带从只读 secret 读取的 `X-Worker-Token`：

- `/worker/start` 注册新的启动身份与非敏感模型状态。
- `/jobs/claim` 领取排队任务；暂时无任务返回 null。
- `/jobs/{id}/heartbeat` 续约并读取取消状态。
- `/jobs/{id}/events` 写入执行事件。
- `/jobs/{id}/finish` 提交最终状态；身份被替换或任务已终止时拒绝迟到写入。

## 数据校验

`app.contracts.validate_result` 校验四阶段 envelope 和核心数据结构，并可结合固定源码检查证据位置。跨阶段需要传入关联上下文：API 标识、字段引用、检查编号、要求编号和操作编号；缺失或无效引用被拒绝。支持核对 `source_revision`。

不开放向平台任意写入阶段成果的公开接口。Stage 1 内部检查点通过这个校验器保存；Stage 2—4 尚未实现。模型不得直接决定 `source_revision` 等任务元数据。

`bindings` 的内部描述形式未在最终方案固定，因此首版只接受对象列表，不擅自规定关系语言。`trace` 接受全为文字步骤或全为 `{from,to,evidence}` 的列表，不允许同一条 trace 混用。检查的生效条件和例外必须由分析阶段明确记录，JSON Schema 不能证明授权语义正确。

## 存储与恢复

- PostgreSQL 保存项目、快照元数据、任务、任务内序号事件、成功 Probe 结果及 Stage 1 API/检查点。
- `snapshots` 卷保存固定源码；`runs` 卷保存脱敏会话、Probe 结果副本与快照 manifest。
- 数据库中的成功结果是接口读取的依据，任务目录文件用于复核，不承担跨数据库和文件系统的分布式事务。
- 空结果、未配置和中断都不得转换为安全结论。后续 Stage 保存时也遵循该要求。

## 配置与维护

依赖锁文件分别为 `api/requirements.lock`、`web/package-lock.json`、`worker/package-lock.json`。镜像固定到本次构建的基础镜像 digest；更新依赖需重新构建、执行测试并记录版本。

不得自动加载被测仓库中的扩展；不得将漏洞答案挂载到 Worker；不得使用全盘路径挂载。后续需运行被测项目时，应另行设计隔离执行环境。

## Stage 1 扩展（批次二）

`POST /api/jobs` 接受 `{kind:"stage1_extract", snapshot_id, options:{include_paths:["jeecg-boot"], enrich:true}}`。`options.base_run_id` 显式请求复用兼容检查点，返回新任务；源任务必须终止，快照、扫描范围及提取器版本必须相同。

- `GET /api/jobs/{id}/apis` 分页筛选 API。
- `GET /api/jobs/{id}/apis/{api_id}` 获取字段及证据。
- `GET /api/jobs/{id}` 的 `analysis` 保存扫描文件记录、诊断、用量及补全状态。任务列表不嵌入大型结果。
- `/internal/jobs/{id}/stage1/checkpoints` 分批保存成果；`/internal/jobs/{id}/stage1/base` 读取已授权的兼容结果，均校验 Worker token 与任务所有权。

具体参数、预算、状态和兼容性见 [Stage 1 文档](stage1.md)。`schema_version: "0.4"` 保持不变，HTTP 方法枚举兼容新增 `ANY`；旧结果继续有效。

## Stage 2 扩展（批次三）

`POST /api/jobs` 新增 `kind: stage2_analyze`，options 必须指定 stage1_run_id 与 api_id。来源必须是同一快照的终止 Stage 1 任务且包含有效 API，允许来源为 partial。任务创建即复制来源内容及哈希；不向模型开放任务元数据控制。

`GET /api/jobs/{id}/analysis` 返回固定来源与分析详情；result 返回单 API 的 v0.4 Stage 2 数据。取消、失败或重启后，有有效检查点则可以读取 partial；没有有效成果仍返回 409。

内部 `/jobs/{id}/stage2/context` 与 `/jobs/{id}/stage2/checkpoints` 复用 Worker token、启动身份和任务所有权校验。追加的 0003_stage2 迁移保留历史数据。接口预算与准确性边界见 [Stage 2 文档](stage2.md)。
