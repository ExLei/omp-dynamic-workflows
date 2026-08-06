export const meta = {
  name: "phased_budgets",
  description: "Bound noisy work with named phase budgets and report shared token spending truthfully",
  phases: [{ title: "Explore" }, { title: "Deliver" }],
};

// ADAPT: 校验工作并选择各阶段预算、提示词与 schema；仅当用户明确要求上限时才添加调用级 tokenBudget。
const work = args && Array.isArray(args.work) ? args.work.slice(0, 8) : [{ id: "sample" }];
const phaseBudget =
  args && Number.isFinite(args.phaseBudget) ? Math.max(1, Math.min(args.phaseBudget, 100000)) : 2000;
const resultSchema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};
const phases = [];

phase("Explore", { budget: phaseBudget });
const exploreStart = budget.spent();
const explored = [];
const exploreMissing = [];
const exploreAttempted = work.map((item) => String(item.id));
for (let index = 0; index < work.length; index++) {
  const item = work[index];
  const id = String(item.id);
  try {
    const result = await agent(`Explore this bounded work item: ${JSON.stringify(item)}`, {
      label: `explore:${index}:${id}`,
      schema: resultSchema,
    });
    if (result === null) exploreMissing.push(id);
    else explored.push({ id, index, result });
  } catch (error) {
    if (!error || error.code !== "TOKEN_BUDGET_EXHAUSTED") throw error;
    // INVARIANT: 软门禁会拦截本次及后续调用；把所有预期身份标识保留为缺失覆盖。
    exploreMissing.push(...work.slice(index).map((remaining) => String(remaining.id)));
    break;
  }
}
phases.push({
  title: "Explore",
  startSpent: exploreStart,
  endSpent: budget.spent(),
  attempted: exploreAttempted,
  missing: exploreMissing,
});

phase("Deliver");
const deliverStart = budget.spent();
const delivered = [];
const deliverMissing = [];
for (const item of explored) {
  const result = await agent(`Turn this exploration into a deliverable: ${JSON.stringify(item.result)}`, {
    label: `deliver:${item.index}:${item.id}`,
    schema: resultSchema,
  });
  if (result === null) deliverMissing.push(item.id);
  else delivered.push({ id: item.id, result });
}
phases.push({
  title: "Deliver",
  startSpent: deliverStart,
  endSpent: budget.spent(),
  attempted: explored.map((item) => item.id),
  missing: deliverMissing,
});

// INVARIANT: 阶段预算与总预算都是调用前的软门禁；已完成的进行中工作可能超出上限。
return {
  phases,
  delivered,
  totalSpent: budget.spent(),
  remaining: budget.remaining(),
  complete: exploreMissing.length === 0 && deliverMissing.length === 0,
};
