# Authz Agent

以源码证据驱动的授权分析工作台。第一批交付 Docker 运行基础、源码快照、任务链路与 Pi 接入。**Stage 1—4 分析算法尚未实现，界面不会生成模拟漏洞结论。**

## 技术组成

- `web`：Next.js 16 / React 19 / TypeScript。
- `api`：Python 3.12 / FastAPI / SQLAlchemy。
- `agent-worker`：Node.js 24 / Pi Coding Agent SDK 1.3.0。
- `db`：PostgreSQL 17。
- 四阶段数据契约：`contracts/stage-*.schema.json`，版本 `0.4`；最终确认原文见 `docs/approved-v0.4.txt`。

## 本地启动

需要 Docker Desktop（Compose）。宿主机无需安装 Node、Python 包或 PostgreSQL。

```sh
./scripts/init.sh
docker compose up --build -d
```

打开 <http://127.0.0.1:3000>。默认源码允许目录是项目仓库的相邻 `../project`，即包含 JeecgBoot、JeeSite5 的目录。其他布局请修改 `.env` 的 `SOURCE_ROOT`（绝对路径也可），然后重新创建 API 服务：

```sh
docker compose up -d --force-recreate api
```

在界面登记源码目录、创建快照后，可以浏览源码证据或提交独立的 Agent 连通性任务。快照可能需要等待，期间不会执行被测项目的代码。默认不接收上传或自动拉取远端源码。

## 配置模型

本批支持具备 **流式 Chat Completions 与工具调用**能力的 OpenAI 兼容接口，配置并不等于接口已经验证成功。

1. 在 `.env` 中设置 `MODEL_BASE_URL`（通常以 `/v1` 结尾）和 `MODEL_ID`。
2. 将 API 密钥单独写入 `.secrets/model_api_key`，不要写入聊天、源码或 Compose 文件。
3. 运行 `docker compose up -d --force-recreate agent-worker`。
4. 选择快照文件（例如 `README.md`），提交连通性任务。只有观察到 Pi 实际读取指定文件且正常返回，才记录成功。

若服务运行在宿主机上，容器中的 `localhost` 指向容器自身，应使用 Docker Desktop 的宿主机地址。不要使用包含用户名、密码或密钥查询参数的 Base URL。

初始密钥文件为空，未配置时平台正常启动，任务以 `model_not_configured` 明确失败，不返回模拟成功。Responses-only 接口不在本批适配范围。

## 隔离边界

- 仅 Web 发布到 `127.0.0.1:3000`；API、Worker 与数据库没有宿主机公开端口。
- 原始源码对 API 只读；固定快照对 Worker 只读。`vulnReports`、论文、用户主目录不挂载。
- 快照按文件相对路径、字节长度及内容 SHA-256 生成确定性版本；原始源码后续修改不影响既有快照。
- `.git`、`.svn`、`node_modules`、`target`、`dist`、`.next`、`.venv` 等不进入快照。首版拒绝符号链接和特殊文件；单快照上限 1 GiB / 100,000 个文件。
- 读取源码限制为 UTF-8 文本、文件不超过 8 MiB。API 单次最多 300 行，Pi 工具最多 100 行；单段内容最多 64 KiB。
- 应用和数据库进程使用非 root 用户。应用根文件系统只读，Worker 默认 2 CPU / 4 GiB / 256 进程。
- 不挂载 Docker socket，不自动加载被测仓库的 Pi 扩展、技能、AGENTS 指令或脚本。
- Pi 仅有 `list_source_files`、`read_source_lines` 两个受限工具。没有通用 Shell、编辑或网络工具；模型调用通过 Worker 的专用出口网络完成。
- Probe 默认超时 90 秒，最多 6 次工具执行及有限模型轮次，不自动重试收费模型请求。
- Pi 会话先保存在内存，在任务结束时写出脱敏的 `transcript.json`；模型密钥不写入会话配置。
- `.secrets` 主目录权限 700；文件只读挂载到所需服务。目录内文件对容器非 root 用户可读，因此不要改变目录权限或提交该目录。

数据库、快照、结果使用命名卷持久化。`docker compose down` 保留数据；不要在需要保留研究记录时使用 `down -v`。

## 任务与结果

- 当前任务类型是 `agent_probe`，不是漏洞扫描，不产生四阶段分析结果。
- 内部状态：`queued`、`running`、`cancel_requested`、`completed`、`failed`、`cancelled`。
- Worker 轮询 PostgreSQL 队列，领取和写事件在数据库事务内完成；单 Worker 顺序执行。
- Worker 每次启动使用新的身份。重启会将旧身份的运行任务标记为 `worker_interrupted`，不自动重跑模型请求。无心跳超过 90 秒的运行任务也会标记中断。
- 排队任务可直接取消；运行任务通过心跳接收取消并中止 Pi。
- SSE 使用任务内递增事件编号，支持 `Last-Event-ID` 或 `after` 续读。
- 阶段格式的 `status` 与内部任务状态是两套概念，不把排队或运行状态写入分析成果。

## 测试

所有依赖安装、构建与测试均在容器内进行：

```sh
docker compose run --rm --no-deps api python -m pytest -q -p no:cacheprovider
docker compose run --rm --no-deps agent-worker npm run typecheck
docker compose run --rm --no-deps agent-worker npm test
make test-postgres
python3 scripts/verify-runtime.py
python3 scripts/smoke.py --source JeecgBoot
```

`test-postgres` 在独立测试数据库中重复 API 测试，退出后删除该测试数据库；不操作平台数据库。最后两条只使用宿主机 Python 标准库检查 Docker 和本地 HTTP 接口，不依赖浏览器操作。其结果写入被 Git 忽略的 `artifacts/`。若修改 Web 端口，需同步调整运行检查脚本中的地址，Smoke 可通过 `--base` 指定。

Worker 测试中的本地协议 fixture 用于验证 Pi SDK 的真实工具执行流程，以及 401、400、超时与扩展隔离；它不是线上模型验收，不进入平台生产数据库。线上模型是否通过见 `docs/acceptance-batch1.md`。

## 第一批限制

- 四阶段算法和复杂依赖图后续逐批实现；当前只提供数据契约与校验函数。
- 这是本机单用户工作空间，不具有面向公网的身份认证和多用户隔离。
- 数据库首版通过 SQLAlchemy 非破坏性建表初始化；后续修改数据库结构时需提供显式迁移，不能自动重建研究数据。
- 快照采用同步接口创建；源码持续变化会导致失败，应该在固定源码上重试。
- 源码文件列表按路径前缀过滤，最多返回 200 项；页面默认 100 项。
- 本批不构建或运行被测应用，不发送漏洞利用请求。

接口与开发约定见 `docs/interfaces.md`；实际验收见 `docs/acceptance-batch1.md`。
