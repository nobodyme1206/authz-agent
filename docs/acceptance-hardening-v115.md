# 1.1.5 首次模型结果与停止记录

冻结提交 4cce79b，分析器 authz-java-1.1.5，批次 hardening-a8103f76f9d44805990d3260a9baa8d9。执行顺序在首次收费前固定为八个中性语义对照，再执行十个 JeecgBoot API；来源哈希和人工预期保持不变，未在轮内修改代码、模型、镜像或预算。

八个语义对照全部正常提交，主要语义与必要证据 **8/8**：可信主体 SQL 范围与客户端筛选、前置 return 与后置检查、未捕获 throw 与 catch 后继续、常量 true 与 false 均正确区分。C05 正式证据覆盖 Controller:10 的比较及 throw，不再只引用写入行。所有对照阶段状态仍为 partial，保留了部署认证、具体数据值、并发等额外疑问；这些不等于关键谓词或执行顺序未知，也不能据此推导漏洞。

| API | 首次任务 | 状态 | Token |
|---|---|---|---:|
| c01 | run-4723102b822840eb961889fdbd002697 | completed / partial | 26,690 |
| c02 | run-6109942d42654bba8773f7fbb15ff400 | completed / partial | 21,315 |
| c03 | run-eec5f2c925d84de7a1f62807ad25c796 | completed / partial | 24,333 |
| c04 | run-a1128323b06245b19124cf31b4961566 | completed / partial | 24,296 |
| c05 | run-bfa4078d614d480887ab30f50993c64d | completed / partial | 29,624 |
| c06 | run-6b06dda29ae04e2e89452a89b18ea71a | completed / partial | 19,326 |
| c07 | run-983b3846a7a84864b076f009b6963c0a | completed / partial | 36,531 |
| c08 | run-6683aa502da94106b4e3029da2eb3b96 | completed / partial | 23,778 |
| changeOwenUserTenant | run-d3858895feb84205a3b724dde3e51822 | failed：提交前预留不足 | 38,032 |
| deptRoleUserAdd | run-80d102529e2e4432b09fea3ae208fd6e | failed：提交前预留不足 | 53,043 |

合计 **296,968 Token**。实际只执行十项；连续两个预算失败触发停止，其余八项未执行。八个对照通过不能替代真实接口验收，不能宣布前三批重新验收完成。数据和费用全部保留，后续不能用成功任务替换本轮失败。

修正重点转为减少源码读取往返：将必读源码合并为一次有界工具读取，保持真实位置和未读范围，不提高预算。见 [1.1.6 实现记录](hardening-v1.1.2.md)。
