export const meta = {
  name: "saved_nested_workflows",
  description: "Run bounded jobs sequentially through one context-supplied installed workflow",
  phases: [{ title: "Prepare" }, { title: "Run saved workflow" }],
};

// ADAPT: 只接受由 context 提供的已保存工作流名称，绝不猜测已安装的名称。
const savedWorkflowName = args && typeof args.savedWorkflowName === "string" ? args.savedWorkflowName : null;
if (!savedWorkflowName) throw new Error("args.savedWorkflowName must be supplied by context");
const jobs = args && Array.isArray(args.jobs) ? args.jobs.slice(0, 8) : [{ id: "sample" }];
const preparationSchema = {
  type: "object",
  properties: { ready: { type: "boolean" } },
  required: ["ready"],
};

phase("Prepare");
const preparation = await agent(`Check ${jobs.length} bounded nested jobs for readiness.`, {
  label: "prepare-nested-jobs",
  schema: preparationSchema,
});
const preparationMissing = preparation === null;

phase("Run saved workflow");
const nested = [];
if (preparationMissing || !preparation.ready) {
  for (const job of jobs) nested.push({ id: String(job.id), status: "missing", result: null });
}
for (const job of preparationMissing || !preparation.ready ? [] : jobs) {
  const id = String(job.id);
  // INVARIANT: 每次嵌套运行都 await 完成后再启动下一次；workflow() 只允许一层嵌套。
  const result = await workflow(savedWorkflowName, job);
  const missing = result === null || (typeof result === "object" && result !== null && result.result === null);
  nested.push({ id, status: missing ? "missing" : "complete", result });
}
const missing = nested.filter((entry) => entry.status === "missing").map((entry) => entry.id);

// INVARIANT: 嵌套运行共享父级的 agent/并发/token 限制、计量与存储状态。
return {
  preparation: { status: preparationMissing ? "missing" : "complete", result: preparation },
  nested,
  missing,
  complete: !preparationMissing && missing.length === 0,
};
