export const meta = {
  name: "bounded_semantic_retry",
  description: "Separate recoverable transport retries from a visible bounded semantic attempt ledger",
  phases: [{ title: "Attempt" }],
};

// ADAPT: 定义任务自有的验收标准、提示词、上限与结构化结果字段。
const maxSemanticAttempts =
  args && Number.isInteger(args.maxSemanticAttempts) ? Math.max(1, Math.min(args.maxSemanticAttempts, 5)) : 3;
const transportRetries =
  args && Number.isInteger(args.transportRetries) ? Math.max(0, Math.min(args.transportRetries, 3)) : 0;
const resultSchema = {
  type: "object",
  properties: {
    accepted: { type: "boolean" },
    answer: { type: "string" },
    feedback: { type: "string" },
  },
  required: ["accepted", "answer", "feedback"],
};
const attempts = [];
let feedback = "";
let acceptedResult = null;

phase("Attempt");
for (let attempt = 1; attempt <= maxSemanticAttempts; attempt++) {
  const result = await agent(
    `Produce an acceptable answer.${feedback ? ` Address this prior feedback: ${feedback}` : ""}`,
    {
      label: `semantic-attempt:${attempt}`,
      schema: resultSchema,
      // 运行时的重试会在可恢复的执行失败后重复同一次逻辑调用。
      retries: transportRetries,
    },
  );
  if (result === null) {
    attempts.push({ attempt, status: "missing", result: null });
    feedback = "The previous logical attempt produced no usable coverage.";
    continue;
  }
  const status = result.accepted ? "accepted" : "rejected";
  attempts.push({ attempt, status, result });
  if (result.accepted) {
    acceptedResult = result;
    break;
  }
  feedback = result.feedback;
}

// INVARIANT: 语义性尝试耗尽必须可见地返回，不得当作成功呈现，也不得丢弃。
return {
  ok: acceptedResult !== null,
  exhausted: acceptedResult === null && attempts.length === maxSemanticAttempts,
  result: acceptedResult,
  attempts,
};
