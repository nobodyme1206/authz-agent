# Stage 1 到 Stage 2 的衔接核查

固定来源版本与批次二相同。原 96 个疑难 API 的 104 条问题分为以下九类；问题条数不等于 API 数。

| 类别 | 条数 | 核查代表 | 处理 |
|---|---:|---|---|
| 动态字段名称无法确定 | 29 | AiragMcpController.exportXls → JeecgController.exportXls | 根据请求参数集合动态读取，保留未知 |
| 输入对象进入未解析调用 | 29 | OnlCgformDemoController.enhanceJavaHttp 中 res.put | 外部传播/容器保存不等于新的客户端绑定；保守诊断传入后续阶段 |
| 动态对象字段待核实 | 18 | AppDebugParams 继承的 flowInputs | Map 子键动态；容器类型补全不清除未知 |
| 无法解析 DTO 类型 | 14 | MessageHistory | 外部依赖源码不在快照，不能凭类型名编造属性 |
| 无法解析父类型 | 6 | SysCategory implements Comparable | 已修复：Comparable/Cloneable 是标准行为接口，不提供待展开 DTO 属性 |
| 跨方法追踪超过两层 | 3 | CommonUtils.getBaseUrl | 达到 Stage 1 有界传播限制；Stage 2 有自己的六层导航，不据此推断缺授权 |
| 字段类型冲突 | 2 | SysUserController.list 的 query:status | DTO Integer 绑定与 Servlet String 读取并存，保留歧义 |
| 无法确认属性可绑定 | 2 | XxlJobGroup.registryList | 缺少可确定的写入绑定，保持未知 |
| 集合元素类型未知 | 1 | VxeMockController.immediateSaveAll | 原始 JSONArray 缺少静态元素类型，保持未知 |

上述修复将 Stage 1 提取器版本提升到 spring-java-1.0.5，不改变 API 编号生成规则。历史结果保持原样，新的 Stage 1 任务可以减少这六条误诊断。前端/后端核心字段契约未变化。

Stage 2 固定来源 API 与详情的内容哈希，仅接受已终止的来源任务；不得在来源 Stage 1 整体 partial 时机械拒绝其他已确认的入口。上游未知保守传播，不自动删除。阶段内发现新绑定只记录补查建议，不能静默修改固定输入。
