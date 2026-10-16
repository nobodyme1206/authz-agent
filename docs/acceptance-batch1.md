# 批次一验收记录

验收日期：2026-10-16。环境：macOS / arm64，Docker Desktop。

本批交付运行基础、固定源码快照、任务队列、Pi 接入和最小工作台。四阶段算法保持“待实现”。按用户要求，最终验收采用容器命令、自动化测试和 HTTP 接口，不依赖浏览器点击或页面截图。

**验收结论：批次一范围内的验收项已通过。** 补充的 DeepSeek 真实模型验收已完成；Stage 1—4 算法属于后续批次。

## 已通过

| 项目 | 方法与实际结果 |
|---|---|
| 镜像与服务 | Next.js 生产构建、Worker TypeScript 检查通过；Compose 四服务均 healthy |
| API 功能测试 | SQLite 隔离测试 7 项通过；PostgreSQL 独立测试数据库重复 7 项通过，测试数据库退出后已删除 |
| Worker 测试 | 3 项测试通过，覆盖受限文件工具、错误分类与脱敏、Pi SDK 协议交互 |
| 项目与真实源码 | HTTP 登记 JeecgBoot，生成 4,036 文件、约 74.2 MiB 的固定快照，读取 README 的原始行成功 |
| 版本与只读 | 快照采用文件清单和内容哈希；测试中修改原目录后既有快照保持不变；API 原源码、Worker 快照与应用根目录写入被拒绝 |
| 路径安全 | 越界、绝对路径、符号链接、非法行号、非 UTF-8 数据被拒绝；快照排除依赖和构建目录 |
| 数据契约 | 四阶段基线样例通过；缺失字段、错误类型、无效状态、无效引用、重复字段、错误源码版本和无效位置被拒绝 |
| 任务生命周期 | 创建、领取、顺序执行、排队取消、运行中取消、结果保存、迟到写入拒绝与心跳失效处理通过测试 |
| 重启恢复 | 实际停止并启动 Worker，旧运行任务标记 `worker_interrupted`；没有自动重发模型调用。数据库/API/Web 重启后项目、快照、任务及事件仍可查询 |
| SSE | HTTP 实测按事件编号续读；已读事件不重复返回 |
| 缺配置 | 初始未配置模型时，实际任务明确返回 `model_not_configured`，没有伪造分析结果；补充验收后已配置有效模型 |
| Pi 工具链 | 受控协议服务驱动真实 Pi SDK 调用 `read_source_lines`；工具白名单校验通过，仓库自带 `.pi/extensions` 未被加载 |
| 错误与超时 | 协议测试覆盖 401 认证失败、400 不兼容接口和挂起请求取消；公开错误使用规范错误码，持久化会话过滤测试密钥 |
| 网络与权限 | Web UID 1000，API/Worker UID 10001，PostgreSQL UID 999；只发布 `127.0.0.1:3000`，数据库无宿主机端口；无 privileged、host network 或 Docker socket |
| 资源限制 | Worker 默认 2 CPU / 4 GiB / 256 进程限制生效，可经部署配置调整 |
| 密钥隔离 | 密钥通过只读文件提供；运行检查扫描普通容器日志、HTTP 页面和健康响应，未检出已配置密钥 |
| 分析隔离 | 未执行被测项目脚本、未发送漏洞请求、未实现或模拟 Stage 1—4 分析；Worker 不挂载漏洞报告、论文或个人目录 |

SQLite 与 PostgreSQL 是同一套 7 项测试的两次执行，不能将其视为 14 项独立测试。Pi 协议 fixture 是自动化测试输入，只在临时测试目录中运行，不代表真实模型通过验收，也不作为平台漏洞分析成果。

## DeepSeek 真实模型补充验收

使用用户提供的密钥，只保存在被 Git 忽略的本地密钥文件，并只读挂载至 Worker。端点为 `https://api.deepseek.com`，模型为 `deepseek-flash`。模型和工具调用格式依据 [官方首次调用说明](https://api-docs.deepseek.com/) 与 [工具调用文档](https://api-docs.deepseek.com/guides/tool_calls/) 核对，并通过实际请求验证。

| 项目 | 实际结果 |
|---|---|
| 认证与模型清单 | 官方 `/models` 返回 200，包含所选模型 |
| 成功任务 | `run-46eccde19f75439daead449c2de672d1`，状态 `completed`，无错误；从提交到观察完成约 4.08 秒 |
| 请求链路 | HTTP 创建任务 → PostgreSQL 排队 → Worker 领取 → Pi SDK 调用真实模型 → 工具读取 → 模型回复 → 结果与事件落库 |
| 指定源码 | 固定快照内 `jeecg-boot/jeecg-module-system/jeecg-system-biz/src/main/java/org/jeecg/modules/system/controller/SysTenantController.java`，第 1 行 |
| 内容核对 | 一次 `read_source_lines` 调用，模型回复中的 `package org.jeecg.modules.system.controller;` 与证据读取接口返回的快照内容一致 |
| 事件 | `queued`、`started`、两次 `model_turn`、`tool_started`、成功的 `tool_finished`、`completed`；编号连续，按 Last-Event-ID 续读无遗漏和重复 |
| 用量 | Pi SDK 返回 `input=741`、`output=281`、`cacheRead=640`、`cacheWrite=0`。保留字段原义，不把 SDK 中占位为零的价格配置视为真实账单 |
| 认证失败 | 临时验收 Worker 使用故意无效的凭据访问官方接口，任务 `run-cc9680659f46422ab6bcaae08239b2d3` 明确失败，错误为 `model_authentication_failed` |
| 超时 | 临时验收 Worker 将应用预算设为 50 毫秒并使用官方接口，任务 `run-cbfb253120f3426e9728a04041a05d2d` 明确失败，错误为 `model_timeout`。这是应用截止时间故障注入，不声称官方服务发生了超时故障 |
| 恢复与持久化 | 临时验收容器已移除，正常 Worker 已恢复；随后重启四服务，成功结果保持一致，源码核对及 SSE 续读复核通过 |
| 密钥检查 | 四服务健康，普通日志、页面、健康响应扫描通过；另扫描 runs 卷中的 12 个运行文件，未发现实际模型密钥 |

上述任务均为 `agent_probe`；失败任务不会产生阶段分析结果。源码快照、运行回复、会话文件和密钥不随验收文档进入 Git。`artifacts/live-model-result.json`、`artifacts/live-model-errors.json` 与 `artifacts/verified-live-job.json` 保存本地验收详情。

成功任务可使用以下命令复核；只读取既有任务，不发起新的收费模型调用：

```sh
python3 scripts/verify-live-job.py run-46eccde19f75439daead449c2de672d1
```

## 后续批次范围

Stage 1—4 算法尚未实现，本批仅验证数据结构与基础设施。本次真实模型验收证明指定配置下的基础工具调用链路可用，不代表授权分析算法的准确率已验证。

## 发现的问题与当前限制

- TestClient 依赖产生一条 Starlette 关于 httpx 的弃用警告，测试仍通过；后续升级依赖时处理。
- 平台当前面向本机单用户；不包含多用户登录与资源隔离。
- 创建快照是同步操作；源文件持续变化时会拒绝该快照。首版拒绝所有符号链接。
- 数据库结果与事件事务化保存；文件系统中的结果副本不构成跨数据库的分布式事务。接口以数据库结果为准。
- 结果校验器验证结构、引用和源码位置，不能证明授权规则推断正确。
- 初次通过 Git HTTPS 克隆遇到网络错误，因此在指定目录初始化 `main` 并绑定用户指定的唯一远端；未改写或覆盖远端历史。提交与同步结果见实际交付说明。

## Git 交付状态

首个代码提交：`c5e20cd`（`feat: establish isolated batch-one agent platform`）。全部代码、锁文件、配置模板、测试与文档已提交至本地 `main`。

首次交付时 HTTPS 查询和推送超时，SSH 443 的主机名称也没有对应的已知主机记录，因此当时未确认同步成功。

2026-10-16 再次同步时，使用系统已配置的本地代理恢复连接。HTTPS 缺少 Git 登录凭据；通过 SSH 443、已有 `github.com` 主机记录和本机现有 SSH 密钥，成功认证为 `nobodyme1206`，随后推送 `main` 并建立 `origin/main` 跟踪关系。**GitHub 同步已成功**。

代理、SSH 主机别名与 URL 转换均只作用于本次 Git 命令；`origin` 仍为用户指定的 HTTPS 地址。未关闭主机密钥校验，未修改全局 Git 配置，没有使用强制推送或覆盖远端新增内容。后续同步需使用同样的有效通道，或另行完成 HTTPS Git 登录配置。

## 复核命令

```sh
docker compose ps
make test
make test-postgres
python3 scripts/verify-runtime.py
python3 scripts/smoke.py --source JeecgBoot
```

运行日志和 JSON 验收产物保存至被 Git 忽略的 `artifacts/`，源码快照与 Pi 会话保存在 Docker 命名卷，不进入 Git 仓库。
