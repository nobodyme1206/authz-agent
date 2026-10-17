# 前三批补齐与统一重新验收记录

本轮实现补齐、确定性回归和十八项首次模型验收已执行，但**进入批次四的验收门槛尚未满足**。不能把 13 项任务正常结束说成 13 项验收通过。没有实现 Stage 3—4，没有从漏洞报告反向填写 Requirement。

## 版本与复核协议

- 首次模型批次：`hardening-bc8b048d377b4fbe8627440b76d72351`，分析器 `authz-java-1.1.0`，工具提交 `333d299f873ea296c19a457bf181c8acee5226b1`。
- 后续修正版：`authz-java-1.1.1`，代码提交 `7765bed7a81e6ac9a9d2eb780295e954f08603f0`。修正发生在十八项全部结束之后，仅用 Docker 测试验证，没有把新版本结果替换为首次成功，也没有再次发起收费任务。
- 公共结果继续 v0.4；未增加核心必填字段，未增加业务表。历史 1.0.0、1.1.0 结果可读取，旧版本不能直接继续到 1.1.1。
- 模型 `deepseek-flash`，OpenAI 兼容接口；thinking off，采样参数采用供应商默认；上下文 32,000，每次最大输出 4,096。
- 单任务 60,000 Token、12 轮、30 工具、180 秒模型分析、300 秒总时间；18 项名义合计 1,080,000 Token。
- 全部首次运行按同一代码、镜像、提示词、锁文件和预算执行；没有替换失败任务。版本、镜像哈希、提示词/锁文件哈希、API 输入哈希及逐项复核保存在 [固定验收记录](hardening-v110-review.json)。
- JeecgBoot 是已参与开发的已知基准回归，八个对照是预先设计的语义验收；均不宣称严格盲测或泛化表现。人工核对材料未进入 Agent；Worker 的对照快照只有 16 个 Java 文件。

## 基础环境与历史回归

| 检查 | 状态 | 证据与范围 |
|---|---|---|
| 四服务、非 root、资源/网络/只读隔离 | 通过 | Docker inspect、权限访问检查、HTTP 健康检查；仅 Web 127.0.0.1:3000 公开，Worker 2 CPU/4 GiB/256 进程；无 Docker socket、个人目录、漏洞报告挂载；普通日志/页面/健康接口及 211 个运行产物文件扫描无模型密钥泄漏 |
| 历史读取和持久化 | 通过 | 58 个历史任务全部可读，50 个结果可读，8 个历史失败任务明确返回不可用；保留错误记录。1.1.1 服务重建后，58 个历史任务状态、50 个可用历史结果哈希及本轮十八项结果均保持相同；旧检查点继续到新版被 409 拒绝 |
| 证据与 SSE | 通过 | 读取既有真实 Probe 的固定源码证据，事件顺序和 Last-Event-ID 续读通过；没有额外 Probe 模型费用 |
| 取消、重启、迟到写入与继续 | 通过（冻结版协议验收） | 复用真实 N5 检查点，在空闲 Worker 上检验取消保留、重启标记 worker_interrupted、旧 Worker 迟到写入 409 和兼容继续后取消；没有收费调用 |
| 路径越界、符号链接、缺配置、认证失败、超时、预算 | 通过（Docker 自动化） | API/Worker 测试；模型错误 fixture 不能冒充线上认证或超时验收 |
| 升级后 1.1.1 真实模型重验 | 未执行 | 不自动重复收费任务；需要另建固定版本批次 |

1.1.1 最终 Docker 回归：20 项 API 测试、49 项 Worker 测试和 TypeScript 检查通过；相同 20 项 API 测试在独立 PostgreSQL 测试库通过；Web 生产构建通过。现有 httpx/Starlette 弃用警告不影响测试，但仍需后续维护。

## Stage 1

- 固定 JeecgBoot 源码 `sha256:75acb246045e195624021711446fc99b3b51ea3f1561cf89fdfc468ee45355a6`，4,036 文件。来源未重新下载或切换版本。
- 新任务 `run-27d19f920a2e4f9980a63768ab1dd524`，spring-java-1.0.5，`enrich=false`；模型用量为 0。
- 945 个后端 Java 文件都有处理记录并解析成功，879 个类、1,016 个 API、6,795 个字段位置绑定。全部 API 编号与旧任务一致。
- 原 20 个接口/81 个手工字段绑定精确匹配，未发现该样本集的多报/漏报；这不代表 6,795 个绑定都已经人工核对。
- N1 方法 POST、入口 SysTenantController.java:727、userId/tenantId 的 query/form 备选绑定正确，不加入 username。N5 POST、入口 SysDepartRoleController.java:199，只有 body:userId/newRoleId/oldRoleId，并有 CSV 证据，不加入 departId。
- 91 个疑难 API 共 98 条问题，保留 partial。原版的 Comparable 误诊断已在既有 1.0.5 修正，本轮没有发现需要改变确定性提取行为的新错误，因此不提升提取器版本。

| 问题类别 | 条数 | 代表核查与处理 |
|---|---:|---|
| 动态字段名称无法确定 | 29 | SysMessageController.exportXls → JeecgController.exportXls:77，字段名取外部常量；缺少可解析常量源码，不能编造其值，保留依赖/动态诊断 |
| 动态对象字段待核实 | 18 | JeecgDemoController.oneNativeAdd 接收整个 JSONObject 并写入容器，没有完整子键结构，保留未知 |
| 输入对象进入未解析调用 | 29 | oneNativeAdd 的 data.add(jsonObject) 是容器传播；保守范围诊断，不把服务端生成 id 变为请求字段 |
| 字段类型冲突 | 2 | SysUser DTO status 为整数，Service 的 req.getParameter("status") 为字符串；保留绑定形式歧义 |
| 无法解析 DTO 类型 | 14 | DegradeRuleEntity 等来自快照外依赖，不凭类型名补造属性 |
| 跨方法追踪超过两层 | 3 | AiragPromptsController.promptExperiment → Service/helper → CommonUtils.getBaseUrl，保持既定有界追踪限制 |
| 无法确认属性可绑定 | 2 | XxlJobGroup.registryList 只有计算 getter、没有 setter；不擅自认定可绑定 |
| 集合元素类型未知 | 1 | VxeMockController.immediateSaveAll 的原始 JSONArray 没有静态元素结构 |

Pi 目前可细化已有绑定/类型/说明；深层、跨文件或嵌套动态新增必须能由程序验证，否则拒绝。模型声明 resolved 不能自动清除诊断。相关限制已有回归测试，仍不是完整 Java/Spring 运行时绑定模拟器。

## 十八项首次结果逐项复核

18 项均发生真实模型回复与工具调用；13 项任务正常结束，5 项失败。全部有可读取的 partial 检查点，但失败项没有有效的最终授权语义提交。

八个对照的关键检查极性均正确：主体范围有检查、请求筛选无授权检查；操作前拒绝有效、操作后检查不保护先前写入；未捕获异常中断、捕获后继续不阻断；true 分支有效、false 分支不生效。但 C03/C05/C07 仍把其核心比较列为未核实调用，严格验收只计 5/8 通过，不能以极性正确掩盖关键未知。部分完整对照还保留了与当前谓词无关的部署假设，需要继续改善未知项分层。

| 序号 | API | 首次任务 | 复核结果 | 具体依据或未通过原因 |
|---:|---|---|---|---|
| 1 | `/sys/tenant/changeOwenUserTenant` | `run-36f5dbb188f341609879e2fce8ad747e` | 未通过 | 未形成有效语义提交；两次提交的可选未知项处理说明被过严校验拒绝，最终耗尽预算。不能用静态候选代替 N1 的目标成员检查及 owner 更新结论。 |
| 2 | `/sys/sysDepartRole/deptRoleUserAdd` | `run-88ddc42dcee642618e8154b32ae69f12` | 关键事实通过，partial | 动作权限与注解代理、关系新增/删除及客户端 newRoleId/oldRoleId 来源正确；JWT 带 excludeUrls 条件；仍有辅助调用未核实及冗余配置未知。 |
| 3 | `/sys/role/add` | `run-be19e6cf6cf74e05ab5cb004161da956` | 关键事实通过，partial | system:role:add、SysRole 保存、时间字段覆盖与关闭的租户分支正确；持久化管线及字段默认填充未充分核查，不将 Controller 局部未覆盖推广为完整后端结论。 |
| 4 | `/sys/role/edit` | `run-c71f24dc96ae46ba9d8137ea848cd97e` | 未通过 | 可选未知项处理说明被拒绝后预算耗尽；数据库原角色/请求新角色及关闭分支的预定核对未形成有效提交。 |
| 5 | `/sys/role/listByTenant` | `run-24220a3dc82440c584e7539de4cdc5a9` | 关键事实通过，partial | tenantId 服务端覆盖受 false 开关控制、分页查询正确；QueryGenerator 等调用范围仍未核实，不能声称完整恢复所有 SQL 谓词。 |
| 6 | `/sys/role/list` | `run-5d81e5d07ee8473591b4c4d63db062ab` | 未完整通过 | 动作权限、Service/XML、客户端 roleName/roleCode/id 筛选正确且未当作可信范围；没有明确交代预定核对的 Mapper InterceptorIgnore(tenantLine=true)，还把修改静态开关后的行为保留为冗余未知。 |
| 7 | `/sys/tenant/list` | `run-1e8c2878f66940ffb604fd4d50097c97` | 未通过 | 可选未知项处理说明被拒绝后预算耗尽；数据权限切面到查询消费的语义验收未完成。 |
| 8 | `/sys/sysDepart/queryMyDeptTreeList` | `run-607c7b3a3a82488e93888b52eb2d2ab5` | 未通过 | 模型提交非 Stage 1 正式字段引用，被正确拒绝；审计状态提前更新又导致最终检查点保存失败，用量仅在 SSE 中完整保留。不能把 program-only 候选算作负责部门范围分析。 |
| 9 | `/sys/tenant/exitUserTenant` | `run-bfc89aa9e65c4c24b2948af60b0d3e86` | 未通过 | 提交的操作锚点没有完整阅读证据，拒绝后预算耗尽；密码、退出分支等没有完成有效提交。 |
| 10 | `/sys/randomImage/{key}` | `run-e3815dce1fd544aa83510fc78495faed` | 关键事实通过，partial | 匿名路由正确，没有制造 owner/管理员检查；验证码缓存写入与图片返回分开描述。图形/工具调用处理不完整，保留具体未知。 |
| 11 | `/c01/records` | `run-e41998aaba8b464d8fbe7b49a7818e99` | 关键语义通过，partial | SQL owner_id 的值来自 Principal.getName，形成主体范围，来源与 SQL 均有证据；额外全局认证装配疑问不影响本对照的范围谓词。 |
| 12 | `/c02/records` | `run-25db58e30291465eb287659d5a841da6` | 关键语义通过，partial | 相同 SQL 的 owner 来自请求，保存在非授权事实中，正式 checks 为空；未将普通筛选当作可信授权。 |
| 13 | `/c03/records` | `run-996b784f326c4cac9323d1f3ad05e31e` | 严格验收未通过 | 前置 owner 不匹配直接 return、update 不执行的关键语义正确；但同一核心比较 String.equals 仍列在未核实调用组，结论与关键未知不一致。还存在双方空值/NPE 描述不准确的次要问题。 |
| 14 | `/c04/records` | `run-438d1096014f4de69ade463affa156c0` | 关键语义通过，partial | 先 update 再比较 return，不计为有效保护；后置比较保存在未确认检查中，未解析的比较不改变本对照的操作顺序事实。 |
| 15 | `/c05/records` | `run-d211690271164e73b87f1ba77130509e` | 严格验收未通过 | 未捕获 SecurityException 阻止后续写入的关键语义正确；但核心比较/标准异常构造仍作为未核实调用组，严格完整性不达标。 |
| 16 | `/c06/records` | `run-0968a57ec2e44475945a50b3ae93a454` | 关键语义通过，partial | SecurityException 被 catch 后继续 update；正式 checks 为空，执行效果证据包含 catch 与后续写入。 |
| 17 | `/c07/records` | `run-619236ef68ee464fb15ec35eed2a0aeb` | 严格验收未通过 | ACTIVE=true 时 owner 不符抛异常、写入受保护，极性正确；但核心比较/标准异常构造仍未核实，并把没有源码的全局认证候选列为关键未知。 |
| 18 | `/c08/records` | `run-ddcf2eb836024e99857e9d8a5403b59c` | 关键语义通过，partial | ACTIVE=false 的主体/数据库 owner 比较保留在 inactive_candidates，未成为有效保护；表达“任意 id”应限定在已读 SQL 调用范围，不推断部署外机制。 |

## 用量与失败诊断

事件账本记录的累计用量为 **843,512 Token**。原检查点汇总为 790,546；负责部门树任务的错误提交污染了审计状态，最终检查点未能保存，导致数据库仅记录 17,297，但 SSE 记录 70,263。差额 52,966 在独立验收报告中补记，不改写历史任务。没有以更低的检查点汇总冒充实际用量；SDK Token 统计也不等于供应商最终账单。

四项任务以 token_budget_exhausted 结束，另一个以 model_or_worker_error 结束。后一项的根因包含模型的非法字段引用和错误路径的保存缺陷。Token 是每次请求结束后累计，在途请求可越过名义预算；个别正常提交也略超 60,000。没有自动重新排队或网络重试。结构校验全部通过只代表已保存数据结构有效，不能证明语义验收通过。

## 验收后修正与剩余门槛

1.1.1 修正可选说明的重复要求、无效提交的状态污染和最后有效检查点保护；补充标准 Principal 字符串比较/异常类型归类，仍保留自定义调用未知；未完整模型提交也保存具体调用/机制问题；写操作加入 MybatisInterceptor 字段填充管线核查范围。分别有规则或 SDK/保存失败 fixture 验证，见 [实现说明](hardening-v1.1.md)。

**未执行 1.1.1 的真实模型重验，不能断言这些改动已经使十八项通过。** 当前仍需独立新批次验证：N1/N4/租户列表/负责部门树/退出接口的有效提交；C03/C05/C07 的关键未知；Mapper 忽略设置和持久化字段来源；以及复杂调用/数据权限消费链的预算与输出稳定性。

进入批次四仍然关闭：基础环境与指定 Stage 1 回归通过，条件/效果/调用关联的代码和测试已补齐，但真实接口与对照的严格验收未全部通过。没有用数量、正常结束、partial 或旧成功结果抹去失败。

后续 Requirement 不足的 case 按 [最终 case 评估规范](final-case-evaluation.md)记录证据不足或经复核的方法边界；人工能找到依据而工具未提取的情况属于能力缺口，不得为命中报告补造规则。

## 本地完整审计材料

运行产物不进入 Git。完整清单：`artifacts/hardening-v110-manifest.json`；首次任务记录：`artifacts/hardening-v110-manifest-attempts.json`；逐任务原始 HTTP 结果/分析/SSE：`artifacts/hardening-bc8b048d377b4fbe8627440b76d72351/`；确定性重提取、分类代表与历史读取、生命周期核对：`artifacts/hardening-*.json`。上述任务也可在平台查看。Git 中只保留代码、源码对照、评估预期及精简复核记录，不包含密钥、被测真实项目或完整运行产物。
