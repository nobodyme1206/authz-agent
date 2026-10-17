# 1.1.4 真实重验停止记录

冻结提交 8a43ccd，分析器 authz-java-1.1.4，批次 hardening-536f9e14c9dc449d9dcad69468f77a42。准备十八项，实际运行八项后连续两项预留失败保护停止，未继续余下十项。未在轮内改变代码、模型、镜像或预算。

| API | 首次结果 | Token |
|---|---|---:|
| changeOwenUserTenant | completed / partial | 46,314 |
| deptRoleUserAdd | failed：预留不足，未提交语义结果 | 30,722 |
| role/add | completed / partial | 40,005 |
| role/edit | failed：主操作与辅助查询混合引用被拒，后续预留不足 | 43,450 |
| role/listByTenant | completed / partial | 46,420 |
| role/list | completed / partial | 39,129 |
| tenant/list | failed：提交 JSON 不完整，后续预留不足 | 54,533 |
| queryMyDeptTreeList | failed：预留不足 | 42,484 |

合计 **343,057 Token**；四项正常结束不等于四项语义通过。N1 首次结果还把数据库原 owner 定位更新的条件标为 database_policy，实际没有授权规则加载/消费依据，该检查不成立。本轮未执行 C05 及其余对照，不得据规则测试称为真实对照通过。

本轮结果全部保留。后续修正应对所有类似数据来源、主/辅助引用和提交体积生效，不增加 case 专用判断，不放宽正式证据校验。
