/**
 * Adversarial review mode for workflows.
 * Agents cross-check each other's findings for higher quality results.
 */

export interface AdversarialReviewConfig {
  /** Number of independent reviewers per finding. */
  reviewerCount: number;
  /** Whether to filter out findings that don't survive cross-checking. */
  filterContested: boolean;
  /** Minimum agreement threshold (0-1). */
  agreementThreshold: number;
}

/**
 * Generate an adversarial-review workflow. The script is static and reads its
 * inputs from `args` (task/reviewers/threshold) — no string interpolation.
 *
 * Each finding is judged independently by N reviewers who are told to REFUTE it;
 * a finding survives only when the share of reviewers calling it real meets the
 * agreement threshold.
 */
export function generateAdversarialReviewWorkflow(): string {
  return `export const meta = {
  name: 'adversarial_review',
  description: '对抗式审查：发现由独立怀疑者交叉核对',
  phases: [
    { title: 'Investigate' },
    { title: 'Refute' },
    { title: 'Consensus' },
  ],
}

const task = (args && args.task) || ''
const reviewers = (args && args.reviewers) || 2
const threshold = (args && args.threshold) || 0.5

phase('Investigate')
const investigation = await agent(
  'Investigate the following and list concrete, individually-checkable findings:\\n' + task +
  '\\n\\nIf the task concerns code in this repository, map the relevant symbols and their impact first: ' +
  'call the codegraph_explore TOOL with a plain-text query (only if unavailable, run ' +
  '"bash: codegraph explore <query>" as one clean command, no pipes/grep), then read/grep to verify; ' +
  'use lsp (hover/references) to locate symbols precisely when available.',
  { label: 'investigate', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } }
)
const findings = investigation.findings || []

phase('Refute')
const judged = await parallel(findings.map((f, i) => () =>
  parallel(Array.from({ length: reviewers }, (_, r) => () =>
    agent(
      'You are a skeptical reviewer. Try to REFUTE this finding for the task below. ' +
      'Default to real=false when uncertain. Investigate with the available tools if needed.\\n\\n' +
      'TASK: ' + task + '\\nFINDING: ' + f,
      { label: 'refute ' + (i + 1) + '.' + (r + 1), schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real'] } }
    )
  )).then((votes) => {
    const valid = votes.filter(Boolean)
    const realCount = valid.filter((v) => v && v.real).length
    const ratio = valid.length ? realCount / valid.length : 0
    return { finding: f, realVotes: realCount, totalVotes: valid.length, survives: ratio >= threshold }
  })
))

const survivors = judged.filter((j) => j && j.survives)

phase('Consensus')
const report = await agent(
  'Write a final review report. Include ONLY the findings that survived adversarial review (listed below), ' +
  'each with a short justification. Note how many were discarded.\\n\\n' +
  'SURVIVING FINDINGS JSON:\\n' + JSON.stringify(survivors),
  { label: 'consensus' }
)

return { total: findings.length, survivors, report }`;
}

/**
 * Generate a multi-perspective analysis workflow.
 *
 * `topic` and each `perspectives` entry are user-supplied strings baked
 * directly into the generated script's source, so every one is embedded via
 * JSON.stringify — a proper JS string literal that can't be broken out of by
 * a quote, backslash, or backtick in the value.
 */
export function generateMultiPerspectiveWorkflow(topic: string, perspectives: string[]): string {
  const perspectiveAgents = perspectives
    .map((p, i) => {
      const label =
        p
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 20) || `perspective-${i + 1}`;
      const prompt =
        `Analyze from ${p} perspective: ` +
        topic +
        `\n\nIf this topic concerns code in this repository, map the relevant symbols first: ` +
        `call the codegraph_explore TOOL with a plain-text query (only if unavailable, run ` +
        `"bash: codegraph explore <query>" as one clean command, no pipes/grep), then read/grep to verify; ` +
        `use lsp (hover/references) for precise symbol location when available.`;
      return `  () => agent(${JSON.stringify(prompt)}, { label: ${JSON.stringify(label)} }),`;
    })
    .join("\n");

  return `export const meta = {
  name: 'multi_perspective_analysis',
  description: ${JSON.stringify(`从 ${perspectives.length} 个不同视角进行分析`)},
  phases: [
    { title: 'Perspective Analysis' },
    { title: 'Synthesis' },
  ],
};

phase('Perspective Analysis');
const topic = ${JSON.stringify(topic)};
const analyses = await parallel([
${perspectiveAgents}
]);

phase('Synthesis');
const synthesis = await agent(
  'Synthesize these different perspectives into a balanced analysis:\\n' +
  'Analyses: ' + JSON.stringify(analyses) + '\\n' +
  'Topic: ' + topic,
  { label: 'synthesizer' }
);

return { analyses, synthesis };`;
}
