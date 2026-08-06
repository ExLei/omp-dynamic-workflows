export const meta = {
  name: "validated_gate",
  description: "Use validator feedback to steer bounded structured attempts through gate()",
  phases: [{ title: "Validate" }],
};

// ADAPT: 替换任务、结构化字段与任务自有的验收策略。
const task = args && typeof args.task === "string" ? args.task : "Produce an acceptable answer.";
const maxAttempts =
  args && Number.isInteger(args.maxAttempts) ? Math.max(1, Math.min(args.maxAttempts, 5)) : 3;
const resultSchema = {
  type: "object",
  properties: {
    acceptable: { type: "boolean" },
    answer: { type: "string" },
    feedback: { type: "string" },
  },
  required: ["acceptable", "answer", "feedback"],
};
const ledger = [];

phase("Validate");
const outcome = await gate(
  async (feedback, attempt) => {
    // gate() 最初提供 undefined 的 feedback，以及从 0 开始的尝试序号。
    const value = await agent(
      `${task}${feedback ? ` Address this validator feedback: ${feedback}` : ""}`,
      {
        label: `gate-attempt:${attempt + 1}`,
        schema: resultSchema,
      },
    );
    ledger.push({
      attempt: attempt + 1,
      feedbackReceived: feedback ?? null,
      accepted: false,
      validatorFeedback: null,
      value,
    });
    return value;
  },
  (value) => {
    // 校验器必须返回对象；裸布尔值永远不会被当作通过判定。
    const ok = value !== null && value.acceptable === true && value.answer.trim().length > 0;
    const feedback =
      value === null
        ? "The previous attempt returned no usable result."
        : value.feedback.trim() || "The answer did not satisfy the acceptance policy.";
    const entry = ledger[ledger.length - 1];
    entry.accepted = ok;
    entry.validatorFeedback = ok ? null : feedback;
    return ok ? { ok: true } : { ok: false, feedback };
  },
  { attempts: maxAttempts },
);

// INVARIANT: 显式返回门禁耗尽状态，连同每一次尝试与反馈交接。
return {
  ok: outcome.ok,
  value: outcome.value,
  attempts: outcome.attempts,
  ledger,
};
