# 批次二验收记录

日期：2026-10-16。范围：Java/Spring MVC Stage 1；Stage 2—4 未实现。

验收使用 Docker 内构建与测试、HTTP、数据库及容器检查。没有通过浏览器操作或截图判定通过，没有运行 JeecgBoot、项目构建脚本或漏洞请求。漏洞报告、论文和人工预期答案未挂载给 Worker。

## 固定源码与真实提取

- 快照：`snap-4a6084f0a6b24b9daa7446f23b873d27`。
- 源码版本：`sha256:75acb246045e195624021711446fc99b3b51ea3f1561cf89fdfc468ee45355a6`。
- 提取器：`spring-java-1.0.4`；Controller 范围：`jeecg-boot`。
- 最终真实模型任务：`run-bcf106d467c5438ca3ece143f9cefbe5`。
- 945 个生产 Java 文件均有处理记录，解析失败 0；索引得到 879 个类/接口，结果包含 1,016 个 API、6,795 个字段绑定记录。
- 96 个 API 保留未解析项。内部任务正常完成，阶段结果为 **partial**。字段绑定数包含同一字段的不同输入位置，不表示全项目唯一字段数。

以上数量仅用于复核同一快照，不证明全部接口和字段已经正确。动态对象、外部依赖、反射、自定义绑定和复杂泛型可能需要继续分析。

## 检查结果

| 检查 | 结论 | 依据 |
|---|---|---|
| 解析与绑定规则 | 通过 | Docker Worker 自动测试，精确断言注解、常量、继承、多路径/方法、ANY、嵌套/泛型/集合 DTO、字段重命名、动态键、两层传播、Multipart/Servlet、解析失败及稳定 ID |
| API 与数据校验 | 通过 | Docker API 测试覆盖无效路径/行号/标识/类型、分页筛选、大结果、检查点、迁移兼容及取消/重启 fencing |
| N1 回归 | 通过 | 目标入口的 userId、tenantId 绑定正确，没有添加 username |
| N5 回归 | 通过 | userId、newRoleId、oldRoleId 正确；列表编码有源码依据，没有添加 departId |
| 20 个真实接口人工抽查 | 通过 | 手工查看 Controller/DTO 后记录 docs/jeecg-stage1-samples.json；HTTP 输出 81 个绑定精确匹配，缺失 0、额外 0；包含上述两例及 18 个普通业务接口 |
| 真实 Pi 工具调用及增量保存 | 通过 | 下文真实 DeepSeek 记录，结构化提交被校验后保存 |
| 无模型、模型错误及超时 | 通过 | 程序结果保留；SDK/受控 HTTP 测试覆盖配置缺失、认证失败、超时与异常，未以伪模型结果替代 |
| 自动补全预算 | 通过 | 受控 SDK 测试和真实任务均以 1 API 预算验证停止后不再开启下一 API；部署默认值已恢复 20 |
| 取消与检查点 | 通过 | 实际 HTTP 取消正在运行的任务，保留 1,016 个 API 的 partial 结果 |
| Worker 重启与继续 | 通过 | 实际重启 Worker 后标记 worker_interrupted，保留 115 个 API；显式新任务复用兼容检查点，得到 1,016 个稳定 ID；未自动恢复模型调用 |
| 大结果与 SSE | 通过 | Stage 1 结果超过 Probe 的 64 KiB 限制，完整下载成功；HTTP 验证事件编号及续读 |
| 批次一兼容 | 通过 | 原有项目、快照、Probe 结果保留，旧调用与迁移测试通过 |
| Docker 与隔离 | 通过 | 四服务健康、非 root；仅 Web 公开 127.0.0.1:3000；原始源码/API 与快照/Worker 只读，Worker 无 Docker socket/报告/个人目录挂载 |
| 普通输出密钥检查 | 通过 | 普通日志、首页、状态、Stage 1 结果及提交候选文件未出现本地 secret 原文 |

最终测试：API 11 项通过（SQLite 与 PostgreSQL 均执行通过），Worker 19 项通过，Worker TypeScript 检查通过，Web Docker 生产构建及 TypeScript 检查通过。SQLite 与 PostgreSQL 执行的是同一组 API 用例，不累计为两倍独立测试覆盖。API 测试有一条 Starlette/httpx 弃用提示，未影响断言；后续依赖升级时处理。

## 真实模型补全证据

使用已有 DeepSeek OpenAI 兼容配置，按源码位置排序，第一个疑难接口为 `POST /airag/app/debug`，不是按漏洞位置选取。

Pi 读取 `ChatSendParams.java`，根据第 68 行 `Map<String, Object> flowInputs`，为既有 body 字段 flowInputs 将 type 从 null 补充为 object。继承 DTO 的绑定关系已由程序建立，模型没有增加任意子键。详情中的 enrichment_accepted 为 1，证据相对路径及行号可通过同一快照读取。

本次模型任务尝试 1 个 API，采纳 1 个字段增量，跳过 95 个疑难 API，停止原因 api_budget_exhausted。SDK 报告：input 2,213、output 667、cacheRead 6,912、cacheWrite 0，总计 9,792 Token。总任务耗时约 11.89 秒。Token 为 SDK 用量，不是费用估算。

为限制验收费用，真实验收临时设置 `STAGE1_MAX_ENRICH_APIS=1`；验收后已恢复默认 20 并重新创建 Worker。本次结果仍有 96 个未解析 API，因为确认容器类型不等于解析其动态子字段，模型不能单方面清除程序诊断。

开发期间的模型试跑出现过工具读取行数超限、getter 证据匹配过严、预算中止时误计缺失用量，以及模型未提交有效增量的问题。相应处理已修复并有回归断言；这些历史任务仍保留，不将它们算作补全成功。上述最终任务使用修复后的版本。

## 生命周期复核编号

- 同版本基准：`run-43bbb19e26ce4b3eb577ab6f18e512a7`。
- 取消：`run-44b527f91ee44f639c4168635995e443`，cancelled_by_user，partial / 1,016 API。
- 重启中断：`run-c0c04f0347d34e2bab6cdb5685c229b8`，worker_interrupted，partial / 115 API。
- 显式继续：`run-6753a951793d436a95dc32dab379045e`，1,016 API、稳定 ID 对齐、模型用量 0。
- 批次一真实 Probe：`run-46eccde19f75439daead449c2de672d1`，迁移后仍可读取原结果及事件。

运行产物位于被忽略的 artifacts 与 Docker runs 卷，不提交到 Git。

## 复核命令

```sh
make test
make test-postgres
python3 scripts/verify-runtime.py
python3 scripts/verify-stage1-samples.py run-bcf106d467c5438ca3ece143f9cefbe5
```

重新执行完整扫描可运行 `python3 scripts/stage1-smoke.py`，默认只执行程序提取。`--enrich` 会真实调用收费模型。`scripts/verify-stage1-lifecycle.py` 只有显式传入 `--exercise-restart` 才重启 Worker，执行前应确认没有其他研究任务。

## 限制与未执行项

- 未对全部 1,016 个 API 做人工字段核对，20 个样本的通过率不能外推为全项目精确率。
- 未做运行时 Spring 注册验证、全部自定义 Spring 注解/绑定器兼容，以及其他语言后端支持；本批提取的是源码声明。
- 模型新增字段校验有意保守，不能证明绑定的跨文件/深层动态字段继续 unresolved。预算与模型随机性也可能使结果保持 partial。
- 没有用完默认 20 API / 100,000 Token 来追求全量模型覆盖；没有进行漏洞判定或启动 Stage 2。
