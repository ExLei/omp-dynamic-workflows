# 模式选择

从数据依赖出发，然后只阅读匹配的示例。JavaScript 负责枚举、身份、排序、去重、界限、停止、括号与失败账本。智能体负责语义工作。

<a id="fan-out-and-synthesize"></a>
| 依赖形状 | 模式 | 改编时保留 | 示例 |
| --- | --- | --- | --- |
| 异构条目需要不同处理 | 分类后行动 | 先完成全部分类再做路由行动；按条目 ID 记录分类与行动失败 | [改编](../examples/classify-and-act.js) |
| 独立工作需整体判断 | 扇出与综合 | 传 thunk；await 完整集合；把每个预期 ID（包括 `null`）都交给综合 | [改编](../examples/fan-out-and-synthesize.js) |
| 主张需要怀疑式核查 | 对抗式验证 | 使用独立的产出方与质疑方调用；产出结束后再开始质疑；两方失败都记账 | [改编](../examples/adversarial-verification.js) |
| 探索应先发散再按单一评分标准收敛 | 生成与过滤 | 先完成生成；在过滤调用之前确定性地去重并限制候选 | [改编](../examples/generate-and-filter.js) |
| 两两比较优于绝对评分 | 锦标赛 | 让 JavaScript 运行有界的括号与轮空；智能体只比较一对；记录比赛失败 | [改编](../examples/tournament.js) |
| 工作量基数未知 | 循环直至完成 | 按稳定键去重；只把成功且为空的轮次计为干轮；限制轮数；保留失败的轮次 | [改编](../examples/loop-until-done.js) |

对每种模式，在扇出前校验并限制输入，使用稳定 ID 与唯一标签，保留缺失覆盖，并返回纯 JSON 数据。仅当任务同时具备两种依赖形状时才组合模式。直接工作无需编排。

## 屏障判据：何时用 `parallel()` 等齐，而不是默认 pipeline

多阶段工作**默认用 pipeline()**——屏障（`parallel()` 等齐所有前序结果）只在阶段 N 需要来自全部阶段 N-1 的跨条目上下文时才正确：

- 对全量结果去重/合并后，再做昂贵下游工作
- 总量为零时提前退出（「0 bugs found → 跳过验证」）
- 阶段 N 的提示需要引用「其他发现」做比较

屏障**不是**因为：

- 「我需要先 flatten/map/filter」——放进 stage 内：`pipeline(items, stageA, r => transform([r]).flat(), stageB)`
- 「阶段概念上分开」——那正是 pipeline 建模的东西；分开的阶段 ≠ 同步的阶段
- 「代码更整洁」——屏障延迟是真实的：5 个 finder 中若最慢的是最快的 3 倍，屏障会浪费 2/3 快 finder 的空闲时间

**Smell test**：如果你写了 `const a = await parallel(...); const b = transform(a); const c = await parallel(b.map(...))`，且中间 transform 无跨条目依赖——不需要屏障，把 transform 放进 stage 重写为 pipeline。拿不准时用 pipeline。
