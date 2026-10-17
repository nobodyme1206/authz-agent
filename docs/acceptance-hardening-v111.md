# 修正版 1.1.1 收费模型重验

2026-10-17，用户明确授权后执行。**完整新批次十八项已结束，运行稳定性改善，但严格验收仍未全部通过，继续暂缓批次四。** 本次没有修改生产实现、提示词、依赖或模型参数，没有实现 Stage 3/4，也不输出漏洞命中结论。

## 固定环境与独立性

- 完整批次：`hardening-dd3ff1d891364a649cb7d406bcf0dff7`；分析器 `authz-java-1.1.1`；代码 `5d842bbdd8cbf0d027263e1efc5f634cc52268ef`。
- 同一 JeecgBoot 固定快照与八个中性源码对照；十八个 API 的源码版本、API ID、输入哈希与准备批次逐一一致。人工核对材料哈希也与既定版本一致，没有依据新输出改预期。
- 模型 `deepseek-flash`、thinking off、provider 默认采样；上下文 32,000，输出上限 4,096。每 API 60,000 Token、12 轮、30 工具、180 秒模型/300 秒任务时间。
- 完整十八项期间镜像、代码、提示词、锁文件、模型与预算保持一致，执行结束后再次核对 fingerprint 相同。完整冻结元数据与逐项输入见 [精简审计记录](hardening-v111-review.json)。
- 重新确定性提取来源任务为 `run-9ea12414acf441ca88e890bdc2a4f5b5`；enrich=false，20 个 API/81 个字段样本精确匹配，零模型用量。对照快照只有 Java 源码，不含评估预期。
- 本项目属于已参与开发的已知基准回归，对照亦为预先设计；不宣称盲测或泛化成绩。没有读取漏洞报告作为模型输入。

## 执行中的一次操作失误与额外用量

在核对现有验收目录之前重建了 Worker，随后发现已有 `hardening-2bb5c534ebe044aea0eb1f4614ef4ab3` 清单和一项完成的 N1：`run-b512a0ed4ed24337a80ae9f7fa9d24c4`，用量 **59,416 Token**。代码、提示词及锁文件一致，但冻结镜像标识已经变化，因此该单项不能与随后十七项混算为同镜像完整批次。

该单项及原始中断记录均单独保留，未重写任务、未删除费用、未将它挑选为主批次成功结果。新建独立完整批次后运行十八项。**本次实际共 19 个收费任务**：完整批次 777,152 Token，加单独保留的 59,416，共 **836,568 Token**。准备脚本两次确定性扫描不调用模型。累计预算检查包含额外单项，仍在 1,080,000 的本次名义预算内。

这是环境准备顺序错误，而不是模型错误；完整新批次不存在混用镜像或中途调参。未来开始重验应先查看已有 manifest/attempts，再决定是否需要重建 Worker。

## 与上一轮的对比

| 指标 | 1.1.0 首次完整批次 | 1.1.1 本次完整批次 |
|---|---:|---:|
| 实际任务数 | 18 | 18 |
| 正常结束 | 13 | 17 |
| 执行失败 | 5 | 1 |
| 阶段结果为 partial | 18 | 18 |
| 八个对照的检查有无/执行效果判断正确 | 8/8 | 8/8 |
| 对照严格语义、关键未知与引用验收 | 5/8 | 7/8 |
| SDK/事件累计 Token | 843,512 | 777,152 |
| 检查点与事件用量是否一致 | 负责部门树任务不一致 | 18 项全部一致 |

正常结束率和对照验收是不同指标，不能把 17 项正常结束说成 17 项语义通过。所有结果仍为 partial，既有合理未知，也有不必要的部署/数据库假设，需要分别核对。

## 逐项复核

以下只使用本次完整批次的首次结果，不拿中断单项或旧版成功记录替换失败。通过是针对预先固定的关键语义和必要证据；非关键部署装配疑问不会自动变成该对照的失败，更不能由此推导安全或漏洞。

| # | API | 本次首次任务 | 状态 / Token | 语义与证据复核 |
|---:|---|---|---|---|
| 1 | `/sys/tenant/changeOwenUserTenant` | `run-d2708ab9a1354bc3866b46a3d0ec9a02` | completed / 51,736 | 关键事实恢复，partial：正确描述请求目标成员资格（保存于 validation_preconditions，非请求者 owner 检查）、createBy 更新和原 owner 状态更新。核心 checks 只有带路由条件的 JWT；目标关系分类与关键辅助调用仍需改善。不得把“是否应由 owner 发起”的待查提问当作已推断 Requirement。 |
| 2 | `/sys/sysDepartRole/deptRoleUserAdd` | `run-e2c404319aee4d5a8619c9b798ee0eea` | failed / 62,637 | 未通过：执行失败：多操作提交缺少明确的 operation_refs，submit_authorization 被 explicit_operation_refs_required 拒绝，随后 token_budget_exhausted。只保留程序候选，不用旧版 N5 成功任务替换。 |
| 3 | `/sys/role/add` | `run-3d44d87382a749deab45ed5bb010ff63` | completed / 52,513 | 有说明错误，partial：权限串、保存、关闭的租户分支及审计字段管线有记录；但 supporting_operations 把 MybatisInterceptor 的 createTime 空值填充错误写成“强制覆盖”。Controller 本身确有时间覆盖，二者不能混同；updateBy 插入行为的概括也缺少准确区分。 |
| 4 | `/sys/role/edit` | `run-92976b3ddd6b4dc1b4c2d071ff5de42a` | completed / 50,906 | 关键事实恢复，partial：恢复数据库旧角色查询、请求 role 更新、关闭的 tenant 比较及 admin 例外，并记录 UPDATE 审计字段覆盖。没有将 false 分支当作保护；Service 覆写情况未完整核查。 |
| 5 | `/sys/role/listByTenant` | `run-030a5a4d33d84aa7b0091d8257499cc7` | completed / 55,940 | 关键事实恢复，partial：正确表达 tenantId 覆盖受 false 开关控制，未将请求 tenantId 当作主体范围；QueryGenerator 调用链仍有具体未知，且冗余数据库级策略疑问需要分层。 |
| 6 | `/sys/role/list` | `run-f3a9215e5f434fd391537558290fa695` | completed / 58,490 | 未完整通过：读取并描述 Service→Mapper XML 和请求 roleName/roleCode/id 筛选，未将其视为可信授权；仍未明确核对 Mapper 的 InterceptorIgnore(tenantLine=true)，沿用原验收标准判为不完整。 |
| 7 | `/sys/tenant/list` | `run-10ca35f5f3664d01865fa43cf7539797` | completed / 73,584 | 未通过：路由条件有误：数据权限查询、安装及 QueryGenerator 消费链已形成条件式分析，未假设具体数据库策略；但 JWT conditions 声称源码存在 /sys/** anon 规则，实际静态名单没有该通配条目，不能认定路由条件语义正确。 |
| 8 | `/sys/sysDepart/queryMyDeptTreeList` | `run-4ddd99cd367c4eecb98a040208748ffd` | completed / 72,807 | 关键事实恢复，partial：主体 departIds→负责部门→orgCode 前缀范围正确；userIdentity==2 与空 departIds 不查询也有记录，未虚构请求字段。身份字段具体加载及树组装辅助调用仍有未知。 |
| 9 | `/sys/tenant/exitUserTenant` | `run-a723a3fb3f804bc59fefa9f57f1be0dc` | completed / 65,581 | 检查事实恢复，粒度待修正：正确区分 principal 自身成员检查、密码拒绝、owner 退出限制；但把 sys_user_tenant 删除与产品包关系删除合并为一个 operation，不满足不同资源分别关联检查的完整验收要求。TARGET 标签也容易混淆，但规则内明确 user_id=principal id。 |
| 10 | `/sys/randomImage/{key}` | `run-062ae9489b324beabbe27f556c406a09` | completed / 49,022 | 关键事实恢复，partial：匿名规则、验证码缓存和图片响应有证据，没有虚构 owner/管理员检查；图片响应放在 supporting_operations，缓存删除范围和图形工具调用仍待查。 |
| 11 | `/c01/records` | `run-fbab7150096f4bda97596ace3424d996` | completed / 16,701 | 通过关键语义与证据：owner SQL 参数由 Principal.getName 派生；与 Controller、Mapper 实际绑定和谓词相符。部署认证装配问题不影响该对照的已知范围谓词。 |
| 12 | `/c02/records` | `run-42ffbd80825844958e41eb93086201de` | completed / 21,246 | 通过关键语义与证据：id/owner 都来自请求；普通筛选留在非授权事实，正式 checks 为空。额外数据库策略疑问属于范围外事项，不改变对照结果。 |
| 13 | `/c03/records` | `run-5f00869e92d14e47b7cf657684148b28` | completed / 17,302 | 通过关键语义与证据：owner 不符提前 return，阻止后续 update；比较与操作证据覆盖 Controller:10—11 和 Mapper 读取。上一轮 equals 关键调用未知已经消除。 |
| 14 | `/c04/records` | `run-f045eb75ce0f429c929265683c127c10` | completed / 22,770 | 通过关键语义与证据：先 update 再检查；后置比较以 not_blocking 保存，未成为正式保护。Controller:10—11 证据覆盖写入及检查。 |
| 15 | `/c05/records` | `run-2dcbd150e8f34ff5a0ad7f323a22f5d0` | completed / 22,432 | 未通过：关键证据错行：异常中断写入的语义判断正确，核心 equals/异常构造未知已消除；但正式 check.evidence/effect_evidence 只引用 Controller:11 的 mapper.update 和 Mapper 查询，未覆盖 Controller:10 的比较与 throw。源码读过不等于提交的证据支撑该检查，不能算通过。 |
| 16 | `/c06/records` | `run-d7be270530bf456a9f1c308b64993e19` | completed / 24,514 | 通过关键语义与证据：SecurityException 被 catch 后继续 mapper.update；正式 checks 为空，effect_evidence 覆盖 Controller:12—14 的 catch 及写入。 |
| 17 | `/c07/records` | `run-f68df2067e33403e95650ac298d05979` | completed / 36,194 | 通过关键语义与证据：ACTIVE=true、主体与数据库 owner 比较及 throw→update 的关系均正确；Controller:8—14 与 Mapper 证据完整，未再残留核心比较调用未知。额外认证装配疑问与本对照谓词分开评价。 |
| 18 | `/c08/records` | `run-6798b54c97784399bfac0a9706277b55` | completed / 22,777 | 通过关键语义与证据：ACTIVE=false 与比较操作数保留在 inactive_candidates，Controller:8—13 支撑配置与分支；未成为有效保护。 |

## 已得到验证的改进

- 上一轮 N1、角色编辑、租户列表、负责部门树、退出租户的执行失败，本轮均形成有效提交；没有再出现可选未知说明必须重复列在 unresolved 才能提交的阻断。
- 十八项检查点与 SSE 的模型用量一致。失败的 N5 也保存了最后检查点和具体拒绝原因，没有再因错误提交污染状态而丢失最终用量。
- C03/C05/C07 的 String.equals/标准异常构造不再成为核心未解析调用；C03/C07 因此从上一轮严格未通过转为通过。
- SQL 主体范围与客户端筛选、前置拒绝与后置判断、异常中断与捕获后继续、开关 true/false 的关键区分均正确。C05 的语义正确不抵消其证据错行。

## 尚未满足的门槛

1. **多操作关联稳定性**：N5 的 `explicit_operation_refs_required` 触发后耗尽预算。本轮不会重新排队，也不会用旧版成功替代；程序候选不等于完成授权分析。退出接口还把不同表的效果合并为一个操作。
2. **证据语义，而非仅位置有效**：C05 引用的行真实存在且确实读过，但缺少实际比较/throw。现有位置、阅读与结构校验没能拒绝这一语义错配，严格验收 7/8，门槛未满足。
3. **真实接口事实准确性**：角色新增的 createTime 填充条件被概括错误；租户列表条件中出现源码没有的 `/sys/**` anon 通配项；角色列表仍未明确记录既定的 `InterceptorIgnore(tenantLine=true)`。这些不能被 partial 标签掩盖。
4. **分析范围与未知分层**：QueryGenerator/树组装/日志工具等仍有大量调用组待处理，部分已确认配置条件仍重复放在 unresolved；任务失败后的未读机制标记可能仍来自初始检查点，应对照最终 agent_observed 复核，不能把初始标记当作最终阅读事实。
5. **预算行为**：每次响应结束后累计 Token，最终在途请求可使单任务超过 60,000；本轮最高 73,584。该行为已量化记录，不能把名义预算当作硬上限，或把正常结束等同于预算内完成。

后续改进应围绕通用的操作引用约束、检查/拒绝/敏感操作的源码对应关系、必要调用范围和条件粒度，不能给已知 case 添加答案特判。若修改实现或提示词，必须另行固定版本重验，不能覆盖本次结果。本次授权的重验已停止，没有自动开启下一轮收费任务。

## 基础回归与可追溯性

- 全轮使用 Docker、HTTP、容器检查和源码复核，没有截图验收；四服务仍健康，仅 Web 127.0.0.1:3000 公开，源文件及快照只读。
- 上一轮十八个结果内容哈希全部保持不变；本轮结束后 fingerprint 相同。所有十八项都有真实工具调用、可读取的证据和有效引用；结构校验通过不能代替本报告中的语义复核。
- 日志、页面、健康接口及 274 个产物文件扫描未发现模型密钥泄漏。
- 原有 Docker 自动化测试（20 API、49 Worker、PostgreSQL 回归及 Web 构建）作为该生产版本既有证据；本轮没有修改生产代码，不把重跑已有测试当作新增模型效果证据。
- 源码、镜像、提示词、锁文件与输入哈希、逐项任务/复核结果见 [审计记录](hardening-v111-review.json)。完整运行产物保存在本地 `artifacts/hardening-v111-r2-manifest.json`、对应 attempts、`artifacts/hardening-dd3ff1d891364a649cb7d406bcf0dff7/`。中断单项使用独立 `hardening-v111-manifest*` 和批次目录，不进入十八项对比。

本轮只评估实际授权实现提取。尚不能据此声称完整工具已经发现 JeecgBoot 的既有漏洞，更不能为后续 Requirement 不足的 case 补造授权规则。批次四继续暂缓。
