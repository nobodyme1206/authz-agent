# 批次三验收记录

日期：2026-10-16。交付范围：JeecgBoot Stage 2 实际授权检查提取；沿用 schema_version 0.4。Stage 3—4、前端 Requirement 与漏洞判定未实现。

本批已打通固定 Stage 1 输入→单 API 调用导航→真实 Pi 源码阅读→结构化校验→检查点、结果与页面。验收采用 Docker 构建/测试、HTTP 和容器检查，没有浏览器点击或截图验收。没有部署 JeecgBoot、连接其业务数据库、运行其脚本或执行漏洞请求。人工核对要点事先保存在 jeecg-stage2-samples.json，没有作为 Agent 输入；Worker 只挂载源码快照与任务产物。

## 固定来源与 Stage 1 衔接

- 快照：`snap-4a6084f0a6b24b9daa7446f23b873d27`。
- 源码版本：`sha256:75acb246045e195624021711446fc99b3b51ea3f1561cf89fdfc468ee45355a6`。
- 本批 Stage 1 来源：`run-6afc84dea6c6428782e13c296c0d6420`，提取器 `spring-java-1.0.5`，程序提取、不收费补全。
- Stage 2 分析器：`authz-java-1.0.0`；java-parser 3.0.1、saxes 6.0.0。
- 原 96 个疑难 API 的 104 条问题已分九类核查，见 [衔接记录](stage1-handoff.md)。修复 Comparable 标准接口被误当作 DTO 父属性的问题，移除 6 条误诊断（涉及 5 个 API），保留 91 个疑难 API。
- 新结果仍为 945 个生产 Java 文件、1,016 个 API、6,795 个字段绑定，API 标识不变。20 个已人工核对样本的 81 个绑定精确匹配，缺失/额外均为 0。数量不表示全项目准确率。
- 来源整体 partial 可用；API 数据和索引详情在任务创建时固定并哈希，来源后续变化不会改变本次输入。Stage 2 未修改 Stage 1 结果。

## 测试与接口验收

| 项目 | 结果 | 依据与边界 |
|---|---|---|
| API 自动化 | 通过 | 16 项，SQLite 与 PostgreSQL 分别执行同一组用例，不累计为 32 项覆盖；含冻结输入、引用/证据、状态、迁移兼容、继续与 fencing |
| Worker 自动化 | 通过 | 37 项，含原 Probe/Stage 1 回归，新增导航、重载/注入歧义、静态假分支、SQL/XML、证据、预算与真实 Pi SDK 受控协议测试 |
| 类型检查和构建 | 通过 | Worker tsc；Web Docker 生产构建及 TypeScript 检查 |
| 来源与证据校验 | 通过 | 已终止来源、相同快照、字段/操作引用、源码行范围、证据实际读取；相邻阅读可合并，未读间隙拒绝；程序候选行不能冒充模型已读 |
| XML/SQL 安全与导航 | 通过 | 记录 namespace/statement/动态标签/include，SQL 注解及 Provider 源码；不获取 DTD、拒绝内部实体、不执行 SQL/OGNL/Provider |
| 权限与执行效果 | 通过所列样本 | AND/OR、异常捕获、提前返回、操作后检查保留源码供 Pi 判定；十个真实样本人工核对关键事实，见下表；不宣称实现通用控制流证明 |
| 模型异常和预算 | 通过故障注入 | 受控 SDK 覆盖认证失败、缺用量、超时、工具/轮数/Token 上限；缺模型不伪造分析；没有自动收费重试 |
| 取消、重启和继续 | 通过 | 实际 HTTP 检查点回放验证取消/重启/fencing，另有真实 Pi 继续调用；下文区分两者 |
| SSE、结果和元数据 | 通过 | 十个真实任务有模型轮次/工具事件，事件编号递增；旧 Probe SSE 续读通过；阶段结果独立下载，轻量进度接口不重复传整个分析详情 |
| Docker 隔离 | 通过 | 四服务健康、非 root；仅 Web 暴露 127.0.0.1:3000；API/Worker 原始源码及快照只读，无 Docker socket、报告或个人目录挂载 |
| 密钥与提交边界 | 通过 | 81 个仓库候选文件、153 个任务产物文件及普通日志/页面/状态未发现本机密钥原文；.env、.secrets、artifacts 忽略规则有效 |
| 批次一、二数据 | 通过 | 迁移 0003_stage2 保留原记录；旧真实 Probe 的证据/结果/SSE 验证通过；Stage 1 抽查通过 |
| 页面 | 构建与接口通过 | Stage 2 选择/分批入队、详情、条件/映射、证据、未知、取消、下载及继续已实现；未执行浏览器交互/视觉验收 |

Starlette/httpx 有一条依赖弃用提示，未影响测试断言。

## 十个真实 Pi API 的人工复核

以下是每个接口最终选定的真实模型任务，不含失败的开发尝试，也不含检查点协议回放。所有任务内部状态 completed，但阶段状态均为 partial。结构脚本检查固定输入哈希、字段/操作引用、证据读取与源码读取接口、真实工具事件；语义结论由人工按预设要点核对，不能以结构校验代替。

| API | 最终真实任务 | 操作 / 检查 | SDK Token | 核对结果 |
|---|---|---:|---:|---|
| `POST /sys/tenant/changeOwenUserTenant` | `run-ce50900f1d9e4c3b9ad113ea701e9a57` | 5 / 2 | 65,529 | 目标 userId 与 tenantId 的成员关系；createBy 写为目标用户名；没有误写成请求者 owner 检查。 |
| `POST /sys/sysDepartRole/deptRoleUserAdd` | `run-7ae752956c794048b7dc4965422c2e17` | 3 / 2 | 30,920 | 权限注解及 advisor；新增/删除角色关系分开；oldRoleId/newRoleId 均来自客户端。 |
| `POST /sys/role/add` | `run-b6cf909b93b547d28b394b619cb54aec` | 2 / 2 | 46,833 | 动作权限与保存；时间由服务端覆盖；租户开关为 false，不计作保护。 |
| `PUT /sys/role/edit` | `run-148e8a940e344f75b184bfb6bca07729` | 2 / 2 | 45,201 | 先取数据库旧角色；关闭分支比较 TenantContext 与旧租户值，含 admin 例外；部署匿名列表保留条件。 |
| `GET /sys/role/listByTenant` | `run-7c7558eaaaec4977bece98d25a0f7b57` | 1 / 1 | 51,803 | 普通查询筛选；tenantId 服务端覆盖受 false 开关控制，没有当作无条件隔离。 |
| `GET /sys/role/list` | `run-0f77756c466342bb8ae0b29f697bf215` | 2 / 2 | 24,602 | Service→Mapper XML；客户端筛选留在详情；InterceptorIgnore 和租户关闭配置单独记录。 |
| `GET /sys/tenant/list` | `run-982de50f337f4e5e82935f0b5f773b2f` | 1 / 3 | 61,390 | 权限、数据权限 Aspect 安装规则与 QueryGenerator 消费链；具体数据库规则未知且附条件。 |
| `GET /sys/sysDepart/queryMyDeptTreeList` | `run-ea24d40c8f5b4effbb58710a1b259a64` | 2 / 3 | 70,624 | 登录主体 userIdentity/departIds→负责部门 orgCode 前缀→部门树；匿名配置明确为外部未知。 |
| `DELETE /sys/tenant/exitUserTenant` | `run-16352dde5e4942aab15ace15ba3c1a63` | 3 / 4 | 45,010 | 当前用户成员关系、密码复核与 owner 禁止退出分支；删除两类关系及消息；未把自调用 CacheEvict 当生效操作。 |
| `GET /sys/randomImage/{key}` | `run-f8a2a0a29abd4414871745eca0da97b0` | 2 / 0 | 21,637 | 匿名例外、验证码缓存和图片返回；0 条检查符合该读取范围，没有制造 owner 或管理员条件。 |

合计 23 个操作、21 条检查、463,549 SDK Token（含 cacheRead），不是费用估算。部分任务在最后一个在途请求中超过 60,000 软预算；例如部门树任务为 70,624，超额后没有开启新请求。总回复、工具及时间限制仍保留。十个任务的理论预算合计不包含先前开发尝试。

开发过程中实际记录 32 个有模型用量的 Stage 2 任务：26 个任务正常结束、6 个失败，总计 1,538,179 SDK Token。正常结束不表示每次旧输出都通过语义复核。历史错误输出和失败均保留，未覆盖、未删除，也不计入上表通过样本。

## 发现的问题与修正

- 早期输出把空值/存在性检查和客户端 SQL 筛选列入授权检查。现由结构化分类及可信范围来源约束分流到分析详情；未知来源不会进入正式范围检查。
- 早期把关闭租户分支混入 JWT 摘要、把同类自调用的 CacheEvict 当作生效操作。修正全局机制阅读、静态假分支处理及代理调用语义提示，并人工复核相关真实样本。
- 某次部门树提交跨越两段连续已读源码而被拒绝。修复阅读区间联合校验；保留未读间隙的拒绝测试。
- 可选的未生效候选因未完整阅读而阻断合法核心结果。现仅拒绝该候选并记录原因，不丢弃合法操作与检查。
- 继续浏览耗尽预算、提交输出截断、错误字段引用导致过失败。增加短文件引用、紧凑提交、预算提示，并在接近预算时仅开放提交工具、通过 Pi steering 明确收束；仍不保证模型一定成功。
- 程序导航候选与工具阅读记录曾共用一个列表。现分开记录 agent_observed，正式模型证据必须经过工具阅读；历史样本重新排除程序候选后核对仍通过。
- 外部匿名排除配置不能由静态默认路由推断为已确定。定向复验角色编辑和部门树，明确添加适用条件；其余样本的默认 JWT 路由摘要也只解释源码默认流程，不证明部署环境的实际启用状态。

## 生命周期记录

协议回放脚本显式停止空闲 Worker，回放已有真实检查点，不调用模型，不能冒充新的 Agent 分析：

- 取消回放任务 `run-6299046c7c3c4438bf9a8a4d9070687e`：取消后保留 partial 结果。
- 重启回放任务 `run-dd4fecd0040c48d885ffe373a67cccd3`：标记 worker_interrupted，保留检查点，旧启动身份写入返回 409。
- 已排队继续任务 `run-f42314fceb76407b85b096c55cc5ab7e`：兼容性校验通过，调用模型前取消。
- 真正继续任务 `run-7ae752956c794048b7dc4965422c2e17`：从重启回放任务创建，复用 3 个操作和 12 个阅读范围，再进行真实工具阅读与 Pi 提交，30,920 Token，结果 partial。
- 部门树任务 `run-12052514248547df836bb7fc7a02ee27` 达到 Token 预算失败，保留程序候选和实际阅读；显式新建上表继续任务后，复用 2 个候选操作与 14 个范围，完成真实分析。没有自动恢复付费调用。

## 仍存在的限制

1. 十个样本的关键主体、关闭检查、客户端筛选分类已核对通过，不能外推为全部 API 的准确率或完备证明。模型有随机性，历史尝试中的误报/漏报如上所列。
2. unresolved 仍偏保守，例如把具体用户权限授予、某行 owner 的实际值、其他接口写入 departIds 的路径列为待查。这些并非提取已知谓词都必需的信息；目前原样保留，可能降低 completed 比例，不能当作漏洞证据。
3. 操作粒度不完全统一：有的结果把前置读取、分页覆盖或日志分别列出。核心数据库关系和约束可核对，后续比较阶段仍需规范化资源操作，不能直接按数量判断覆盖率。
4. SQL 动态分支、外部框架实现、数据库数据权限策略、部署 profile/环境变量和代理启用条件没有完整执行语义。检查只在给定条件与分析范围内成立；未查询业务数据库验证运行结果。
5. 本批没有实现 Stage 3 Requirement 或 Stage 4 对比，不把 checks: []、partial 或未观察到检查解释为漏洞。

## 复核命令

```sh
make test
make test-postgres
python3 scripts/verify-runtime.py
python3 scripts/verify-stage1-samples.py run-6afc84dea6c6428782e13c296c0d6420
python3 scripts/verify-stage2-results.py --stage1-run run-6afc84dea6c6428782e13c296c0d6420
# 显式进行协议验收，会停止空闲 Worker；不发起模型调用：
python3 scripts/verify-stage2-lifecycle.py <真实Stage2任务ID> --exercise-restart
# 显式进行收费继续分析，不是自动恢复：
python3 scripts/stage2-smoke.py --stage1-run <来源任务> --sample 2 --base-run <兼容检查点任务>
```

运行结果、事件和 transcript 留在本机数据库/任务卷及被忽略的 artifacts，未提交到 GitHub；仓库包含代码、契约、测试、使用文档和本验收记录。
