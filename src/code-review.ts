/**
 * Multi-angle parallel code review workflow.
 * Level-parameterized finder pool → group-by-location verify → sweep → ranked report.
 *
 * Ported structure from the Claude Code 2.1.223 bundled code-review harness:
 *   Find (barrier) → group-by-(file,line) Verify → Sweep (xhigh/max) → decision-based Synthesize.
 * Chinese prompt copy (zh-copy convention); local args { diff, diffSource, level } retained.
 */

/**
 * Hard cap on diff characters fed into the review. This bounds worst-case
 * prompt size across the parallel finders + a per-location verify pass, even
 * when the diff-source exec step (see builtin-commands.ts) already raised its
 * own maxBuffer and successfully read a very large diff. Oversized diffs are
 * truncated rather than rejected — findings in the untruncated prefix still
 * have value — and the truncation is surfaced to the user, not silent.
 */
export const MAX_DIFF_CHARS = 200_000;

/**
 * Generate a code-review workflow script.
 *
 * The workflow expects `args` to be passed with shape:
 *   { diff: string, diffSource?: string, level?: 'high' | 'xhigh' | 'max' }
 *
 * Level routing (ported LEVEL_PARAMS, adapted to the local finder pool):
 *   high  → 3 correctness finders + 1 merged cleanup finder (≤10 findings)
 *   xhigh → + altitude finder + sweep gap pass (≤15 findings)
 *   max   → same structure as xhigh (the model tier may differ)
 *
 * Model tier routing follows the spec:
 *   Correctness A/B/C → medium, cleanup (merged) → small,
 *   altitude G → big, verify groups / sweep / synthesis → big/medium as noted.
 */
export function generateCodeReviewWorkflow(): string {
  return `export const meta = {
  name: 'code_review',
  description: '多角度代码审查：分级发现 → 按位置分组验证 → 排序后的发现报告',
  phases: [
    { title: 'Find' },
    { title: 'Verify' },
    { title: 'Sweep' },
    { title: 'Report' },
  ],
}

const MAX_DIFF_CHARS = ${MAX_DIFF_CHARS}
const rawDiff = (args && args.diff) || ''
const diffSource = (args && args.diffSource) || 'git diff HEAD'
const diffTruncated = rawDiff.length > MAX_DIFF_CHARS
const diff = diffTruncated ? rawDiff.slice(0, MAX_DIFF_CHARS) : rawDiff
if (diffTruncated) {
  log(
    'Diff 已截断审查：仅显示前 ' + MAX_DIFF_CHARS + ' / ' + rawDiff.length +
    ' 字符（省略 ' + (rawDiff.length - MAX_DIFF_CHARS) + ' 字符）。截断点之后的发现不在覆盖内。'
  )
}
// ───── 级别参数（移植自原版 LEVEL_PARAMS，适配本地 finder 池）─────
const LEVEL = args && (args.level === 'xhigh' || args.level === 'max' || args.level === 'high') ? args.level : 'high'
const LEVEL_PARAMS = {
  high: { perAngle: 6, maxFindings: 10, sweep: false, altitude: false },
  xhigh: { perAngle: 8, maxFindings: 15, sweep: true, altitude: true },
  max: { perAngle: 8, maxFindings: 15, sweep: true, altitude: true },
}
const P = LEVEL_PARAMS[LEVEL]
const SWEEP_MAX = 8

const candidateSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
        required: ['file', 'line', 'summary', 'failure_scenario'],
      },
    },
  },
  required: ['candidates'],
}
// 每 (file,line) 位置一个验证代理，按 [i] 索引返回该位置全部候选的裁决。
const groupVerdictSchema = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '该候选的 [i] 标签' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
          evidence: { type: 'string' },
        },
        required: ['index', 'verdict', 'evidence'],
      },
    },
  },
  required: ['verdicts'],
}
// 决策式合成：按索引返回决定，绝不重发发现文本。
const reportSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '要保留进报告的发现 [i] 标签' },
          merge: { type: 'array', items: { type: 'number' }, description: '描述同一根因、折叠进本条的其他发现 [i] 标签' },
        },
        required: ['index'],
      },
    },
  },
  required: ['summary', 'decisions'],
}

const diffBlock = '\\n\\n<diff source=\\"' + diffSource + '\\"' + (diffTruncated ? ' truncated=\\"true\\"' : '') + '>\\n' +
  diff + (diffTruncated ? '\\n\\n[... diff truncated: ' + (rawDiff.length - MAX_DIFF_CHARS) + ' more characters omitted ...]' : '') +
  '\\n</diff>\\n'
const base = 'Use the read/grep tools to pull in any additional file context you need.' + diffBlock

// ───── Finder 池：3 正确性 + 1 合并 cleanup（D/E/F 三透镜）+ 可选 altitude（G）─────
// cleanup 单 finder 覆盖全部 cleanup 透镜、上限 = 透镜数 × perAngle（与旧每透镜
// finder 的总候选预算一致），比旧 D/E/F 三个独立 finder 省 2 个代理。
const CLEANUP_PROMPT =
  'You are a cleanup finder covering THREE lenses. Hunt through each lens in turn:\\n' +
  '1. Reuse: new code duplicating existing helpers/utilities/patterns — name the existing symbol to use instead.\\n' +
  '2. Simplification: redundant derivable state, copy-paste variation that could be a shared function, dead code introduced by the diff.\\n' +
  '3. Efficiency: redundant I/O or network calls, sequential work that could be parallel, blocking ops on startup/hot path.\\n' +
  'Cover whichever lenses apply — you do not need findings from every lens; prioritize the highest-cost issues across all of them. '
const ALTITUDE_PROMPT =
  'You are an altitude reviewer. Assess whether the change is made at the RIGHT abstraction level. ' +
  'Look for: bandaids on shared infrastructure that should be fixed at the root, fixes in the wrong ' +
  'layer (e.g. compensating in the UI for a data model problem), or the change solving a symptom ' +
  'rather than the cause. '
const FINDERS = [
  {
    label: 'A-line-scan', kind: 'correctness', tier: 'medium', cap: P.perAngle,
    prompt: 'You are a line-by-line correctness scanner. Hunt ONLY for: inverted conditions, off-by-one errors, ' +
      'null/nil dereferences, wrong variable used, swallowed errors. ',
  },
  {
    label: 'B-removed-behavior', kind: 'correctness', tier: 'medium', cap: P.perAngle,
    prompt: 'You are a removed-behavior auditor. For every deleted line or block in the diff: name the invariant ' +
      'or contract it enforced, then find where (or prove) that contract is re-established elsewhere. ' +
      'Report only gaps where the invariant is NOT re-established. ',
  },
  {
    label: 'C-cross-file-tracer', kind: 'correctness', tier: 'medium', cap: P.perAngle,
    prompt: 'You are a cross-file call-site tracer. For each function/method whose signature or behavior changed ' +
      'in the diff: grep the codebase for callers, then check whether each call site is still correct after ' +
      'the change. Report only call sites that are now broken or need updating. ',
  },
  { label: 'D-cleanup', kind: 'cleanup', tier: 'small', cap: 3 * P.perAngle, prompt: CLEANUP_PROMPT },
  ...(P.altitude ? [{ label: 'G-altitude', kind: 'altitude', tier: 'big', cap: P.perAngle, prompt: ALTITUDE_PROMPT }] : []),
]
const FINDER_PROMPT = f =>
  'You are a code-review finder (' + f.label + '). ' + f.prompt +
  'For each candidate name the exact file, line number, a one-line summary, and the concrete failure scenario — ' +
  'the user-visible consequence (error, wrong output, data loss), not an intermediate state (value stale, set grows). ' +
  'Return ONLY issues you can justify with a line in the diff. Pass every candidate with a nameable failure ' +
  'scenario through — do not silently drop half-believed candidates; an independent verifier judges them next. ' +
  'If nothing qualifies, return an empty list.\\n\\nStructured output only.' + base

// ───── 路径与位置工具 ─────
const loc = c => c.file + (c.line != null ? ':' + c.line : '')
const inBounds = (i, n) => Number.isInteger(i) && i >= 0 && i < n
const ingest = (cs, cap) => cs.slice(0, cap)

phase('Find')
// 屏障是有意取舍：跨 finder 的位置合并需要每个 finder 的全部输出。
const finderOuts = await parallel(FINDERS.map(f => () =>
  agent(FINDER_PROMPT(f), { label: f.label, tier: f.tier, phase: 'Find', schema: candidateSchema }).then(r => {
    if (!r) return []
    log(f.label + ': ' + r.candidates.length + ' 个候选')
    return ingest(r.candidates, f.cap).map(c => ({ ...c, kind: f.kind }))
  }),
))
const allRaw = finderOuts.filter(Boolean).flat()
// 确定性预去重（file:line:summary 前 40 字符）——与合成 merge 共存：预去重挡
// 完全重复的候选，merge 折叠「验证后仍同根因」的候选。
const seenKey = new Set()
const allCandidates = allRaw.filter(c => {
  const k = (c.file || '') + ':' + (c.line || 0) + ':' + (c.summary || '').slice(0, 40)
  if (seenKey.has(k)) return false
  seenKey.add(k)
  return true
})
if (allCandidates.length === 0) {
  return {
    level: LEVEL,
    summary: '未发现候选问题。',
    findings: [],
    refuted: [],
    stats: { level: LEVEL, finders: FINDERS.length, candidates: 0, verifierAgents: 0, verified: 0, refuted: 0 },
    diffTruncated,
  }
}

// ───── Verify：按 (file,line) 分组，一组一个验证代理返回 N 条 [i] 裁决 ─────
// 相比每候选一个验证代理，按跨 finder 的位置碰撞率省 ~40% 验证代理调用而不丢
// 任何候选。分组不是去重：每条候选保留自己的裁决；语义重复由合成阶段 merge。
// 验证代理未对某候选给出裁决（代理死亡或漏发索引）即丢弃——与旧每候选验证
// 相同的策略——未验证候选绝不作为伪造 PLAUSIBLE 进入报告。代价：一个验证
// 代理失败会丢掉该位置的全部候选。
const GROUP_VERIFIER_PROMPT = group =>
  'You are a code-review verifier. ' + base + '\\n\\n' +
  '## Candidate findings at ' + loc(group[0]) + '\\n' +
  group.map((c, i) =>
    '[' + i + '] Summary: ' + c.summary + '\\n' +
    '    Failure scenario: ' + c.failure_scenario
  ).join('\\n') + '\\n\\n' +
  'Run the diff command above, read the relevant file(s), and return one verdict per candidate. ' +
  'Judge EACH candidate independently on its own claim — candidates at the same location may describe ' +
  'distinct issues, the same issue, or a mix. Reference each by its [i] index.\\n\\n' +
  'VERDICT LADDER:\\n' +
  'CONFIRMED = you can trace the exact failure in the diff. ' +
  'PLAUSIBLE = concern is valid but not certain. ' +
  'REFUTED = finding is wrong or already handled.\\n' +
  'Erring toward high recall: when in doubt between CONFIRMED and PLAUSIBLE, choose PLAUSIBLE so the ' +
  'synthesis report can hedge; only REFUTED removes a finding from the report.\\n\\n' +
  'Structured output only. Evidence must quote or cite the relevant line(s).'

phase('Verify')
let verifierAgents = 0
async function verifyGroups(candidates) {
  const byLoc = Object.create(null)
  for (const c of candidates) (byLoc[loc(c)] ||= []).push(c)
  const groups = Object.values(byLoc)
  verifierAgents += groups.length
  const out = await parallel(groups.map(g => async () => {
    const short = g[0].file.split('/').pop()
    const r = await agent(GROUP_VERIFIER_PROMPT(g), {
      label: 'verify:' + short + '(' + g.length + ')',
      tier: 'big', phase: 'Verify', schema: groupVerdictSchema,
    })
    if (!r) return []
    const byIdx = {}
    for (const v of r.verdicts) if (inBounds(v.index, g.length)) byIdx[v.index] = v
    return g.flatMap((c, i) => byIdx[i] ? [{ ...c, verdict: byIdx[i].verdict, evidence: byIdx[i].evidence }] : [])
  }))
  return out.filter(Boolean).flat()
}
let verified = await verifyGroups(allCandidates)

// ───── Sweep（xhigh/max）：一个全新 finder 只找缺口 ─────
if (P.sweep) {
  phase('Sweep')
  const knownBlock = verified.length > 0
    ? verified.map(c => '- ' + loc(c) + ' — ' + c.summary).join('\\n')
    : '(none)'
  const sweep = await agent(
    'You are a code-review sweep agent — gaps only. ' + base + '\\n\\n' +
    '## Already-found candidates (do NOT re-derive or re-confirm these)\\n' + knownBlock + '\\n\\n' +
    'Re-read the diff and the enclosing functions looking ONLY for defects not already listed. ' +
    'Focus on what the first pass tends to miss: concurrency/race conditions, error paths that are ' +
    'silently swallowed, resource leaks, edge cases in new branches, and cross-module contract drift.\\n\\n' +
    'Surface up to ' + SWEEP_MAX + ' additional candidates. If nothing new, return an empty list — do not pad.\\n\\nStructured output only.',
    { label: 'sweep', tier: 'medium', phase: 'Sweep', schema: candidateSchema },
  )
  if (sweep && sweep.candidates.length > 0) {
    const sliced = ingest(sweep.candidates, SWEEP_MAX).map(c => ({ ...c, kind: 'correctness' }))
    log('sweep: ' + sliced.length + ' 个候选')
    verified = verified.concat(await verifyGroups(sliced))
  }
}

const surviving = verified.filter(c => c.verdict !== 'REFUTED')
const refuted = verified.filter(c => c.verdict === 'REFUTED')
log('验证完成: ' + verified.length + ' 条验证 → ' + surviving.length + ' 保留, ' + refuted.length + ' 驳倒')
const stats = {
  level: LEVEL,
  finders: FINDERS.length,
  candidates: allCandidates.length,
  verifierAgents,
  verified: verified.length,
  refuted: refuted.length,
}
if (surviving.length === 0) {
  return {
    level: LEVEL,
    summary: '没有发现通过独立验证。',
    findings: [],
    refuted: refuted.map(c => ({ file: c.file, line: c.line, summary: c.summary })),
    stats,
    diffTruncated,
  }
}

// ───── Report：决策式合成（按索引 + merge 折叠 + 回填 + 不静默丢弃）─────
phase('Report')
// 正确性/altitude 缺陷优先于 cleanup；CONFIRMED 优先于 PLAUSIBLE（cap 截断时）。
const rank = c => (c.kind === 'cleanup' ? 2 : 0) + (c.verdict === 'PLAUSIBLE' ? 1 : 0)
const ranked = surviving.slice().sort((a, b) => rank(a) - rank(b))
const block = ranked.map((c, i) =>
  '### [' + i + '] ' + loc(c) + ' (' + c.verdict + (c.kind !== 'correctness' ? ', ' + c.kind : '') + ')\\n' +
  c.summary + '\\nFailure scenario: ' + c.failure_scenario + '\\nVerifier evidence: ' + c.evidence + '\\n'
).join('\\n')
const report = await agent(
  '## Synthesis: final code-review report\\n\\n' +
  ranked.length + ' findings survived independent verification (' + LEVEL + '-effort review). They are numbered [0]-[' + (ranked.length - 1) + '] below.\\n\\n' + block + '\\n' +
  '## Instructions\\n' +
  'Return decisions about findings BY INDEX — never re-emit finding text.\\n' +
  '1. For each distinct defect, emit one decision with its index. When several findings describe the same defect (same root cause), keep one entry and list the others in its merge array.\\n' +
  '2. Order decisions most-severe first. Correctness bugs always outrank cleanup findings.\\n' +
  '3. Keep at most ' + P.maxFindings + ' decisions; omit the least severe beyond the cap.\\n' +
  '4. Write a 2-3 sentence summary of the review.\\n\\nStructured output only.',
  { label: 'synthesize', tier: 'big', schema: reportSchema },
)
// 组装不变量：
//   1. 有空间时绝不静默丢弃：每条已验证发现要么出现（primary 或 merge 注记），
//      要么仅因上限已满被省略。
//   2. 显示的 primary 是合成者的选择（d.index）——它挑表述最好的代表；仅当
//      merged 成员为 CONFIRMED 时才升级 verdict 标签。
//   3. summary 描述实际返回的报告。
const decisions = report && Array.isArray(report.decisions) ? report.decisions : []
const seen = new Set()
const claim = i => (inBounds(i, ranked.length) && !seen.has(i) ? (seen.add(i), true) : false)
const findings = []
for (const d of decisions) {
  if (findings.length >= P.maxFindings) break
  if (!claim(d.index)) continue
  const c = ranked[d.index]
  const merged = (Array.isArray(d.merge) ? d.merge : []).filter(claim).map(i => ranked[i])
  const verdict = merged.some(m => m.verdict === 'CONFIRMED') ? 'CONFIRMED' : c.verdict
  const also = merged.length > 0 ? ' [same root cause also at: ' + merged.map(loc).join(', ') + ']' : ''
  findings.push({ file: c.file, line: c.line, summary: c.summary + also, failure_scenario: c.failure_scenario, category: c.kind, verdict })
}
const usedDecisions = findings.length > 0
let backfilled = 0
for (let i = 0; i < ranked.length && findings.length < P.maxFindings; i++) {
  if (seen.has(i)) continue
  const c = ranked[i]
  findings.push({ file: c.file, line: c.line, summary: c.summary, failure_scenario: c.failure_scenario, category: c.kind, verdict: c.verdict })
  backfilled++
}
const summary = usedDecisions && report
  ? report.summary + (backfilled > 0 ? ' (' + backfilled + ' additional verified finding' + (backfilled === 1 ? '' : 's') + ' appended unmerged.)' : '')
  : 'Synthesis step was skipped or its decisions were unusable — returning verified findings ranked, unmerged.'
return {
  level: LEVEL,
  summary,
  findings,
  refuted: refuted.map(c => ({ file: c.file, line: c.line, summary: c.summary })),
  stats: { ...stats, reported: findings.length },
  diffTruncated,
}`;
}
