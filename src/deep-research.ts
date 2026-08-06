/**
 * Deep research workflow.
 * Built-in workflow for comprehensive research across multiple sources.
 *
 * Ported from the Claude Code 2.1.223 bundled deep-research harness:
 *   Scope → pipeline(Search → URL-dedup → Fetch+Extract) → 3-vote Verify → Synthesize
 * Chinese prompt copy (zh-copy convention); local args { question, angles, minSupport }
 * retained, with minSupport mapped to the refutation-vote threshold.
 */

export interface DeepResearchConfig {
  /** Number of distinct search angles/queries to explore (clamped 3..6). */
  angles: number;
  /** Refutation votes required to kill a claim (clamped 1..2; original default 2). */
  minSupport: number;
}

/**
 * Generate a deep-research workflow that uses the real web_search/web_fetch tools.
 *
 * The script is static and reads its inputs from `args` (question/angles/minSupport),
 * so the question is never string-interpolated into source — no escaping hazards.
 * Inject the web tools at run time via the agent's `tools` option.
 */
export function generateDeepResearchWorkflow(): string {
  return `export const meta = {
  name: 'deep_research',
  description: '深度研究：扇出网络搜索、抓取来源、对抗验证主张、输出带引用的报告',
  phases: [
    { title: 'Scope' },
    { title: 'Search' },
    { title: 'Fetch' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

// ───── 参数（运行时读 args，不插值进源码）─────
const question = (args && typeof args.question === 'string' && args.question.trim()) || ''
if (!question) {
  return { error: '未提供研究问题。通过 args 传入：{ question: "..." }。' }
}
// angles：搜索角度数（取整后截 3..6，默认 4）；minSupport：否决票数（取整后截 1..2，默认 2）。
const anglesArg = Number((args && args.angles) || 4)
const angles = Math.max(3, Math.min(6, Math.round(Number.isFinite(anglesArg) ? anglesArg : 4)))
const REFUTATIONS_REQUIRED = Math.max(1, Math.min(2, Math.round(Number((args && args.minSupport) || 2))))

// ───── 常量（移植自原版）─────
const VOTES_PER_CLAIM = 3
const MAX_FETCH = 15
const MAX_VERIFY_CLAIMS = 25
// URL 规范化。沙箱是无 URL 全局的裸 ECMAScript realm，主机名/路径来自正则：
// 捕获 (1) 主机名（userinfo、www. 与端口剥除）与 (2) 路径。userinfo 与主机都不得
// 含 \\：WHATWG 把 \\ 当 http(s) 的路径分隔符，宽松字符类会把 evil.com\\@trusted.com
// 标成 trusted.com 而抓取实际打到 evil.com。userinfo 允许 @ —— WHATWG 在主机前的
// 最后一个 @ 处切分 authority，贪婪匹配必须一致；只停第一个 @ 会把
// x@trusted.com@evil.com 标成 trusted.com 而抓取联系 evil.com。主机字符类仍排除 @，
// 所以 userinfo 组消费到最后一个 @ 为止。
const URL_HOST_PATTERN = /^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#\\\\]*@)?(?:www\\.)?([^/:?#@\\\\]+)(?::\\d+)?([^?#]*)/i
const normURL = u => {
  const m = String(u).match(URL_HOST_PATTERN)
  return m ? (m[1] + m[2].replace(/\\/$/, '')).toLowerCase() : String(u).toLowerCase()
}
// 主机与标题都来自网页内容并经进度标签到达终端。两个危险：伪造可信主机名，以及
// 走私终端控制序列或不可见重排字符。LABEL_STRIP 删除绝不能渲染的内容——C0/C1 控制
// 符（含 ESC/CSI 即 ANSI 引入符）、Unicode 双向覆盖/隔离符与零宽格式字符
// （U+200B-200F、U+202A-202E、U+2066-2069、U+FEFF——它们在视觉上重排或隐藏标签
// 文本）、以及整族双引号近似形（ASCII " 加 U+201C-201F、U+2033、U+2036、U+275D、
// U+275E、U+301D、U+301E、U+FF02——其中任何一个都会在视觉上提前闭合引号回退并在
// 其后伪造主机形文本）。STRICT_HOST 是裸标签必须匹配的严格可注册主机名字符集
// （点分隔 LDH 标签）。normURL 保留原始捕获：去重键永不渲染，剥除会误撞不同 URL。
const LABEL_CAP = 40
const LABEL_STRIP = /[\\x00-\\x1f\\x7f-\\x9f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff\\u0022\\u201c-\\u201f\\u2033\\u2036\\u275d\\u275e\\u301d\\u301e\\uff02]/g
const STRICT_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const stripLabelChars = s => String(s).replace(LABEL_STRIP, '')
// 把网页控制的值渲染为明确不可信的引号标签：清洗危险字符、按 LABEL_CAP 码点截断
// （Array.from 保证代理对不劈开），并在真的截断时把 … 追加在引号内——缩短后的
// 字符串永远不能冒充完整值。
const quotedLabel = s => {
  const cps = Array.from(stripLabelChars(s))
  return '"' + cps.slice(0, LABEL_CAP).join('').trim() + (cps.length > LABEL_CAP ? '…' : '') + '"'
}

// ───── Schemas（结构化输出契约）─────
const SCOPE_SCHEMA = {
  type: 'object', required: ['question', 'angles', 'summary'],
  properties: {
    question: { type: 'string' },
    summary: { type: 'string' },
    angles: { type: 'array', minItems: 3, maxItems: 6, items: {
      type: 'object', required: ['label', 'query'],
      properties: {
        label: { type: 'string' },
        query: { type: 'string' },
        rationale: { type: 'string' },
      },
    } },
  },
}
const SEARCH_SCHEMA = {
  type: 'object', required: ['results'],
  properties: {
    results: { type: 'array', maxItems: 6, items: {
      type: 'object', required: ['url', 'title', 'relevance'],
      properties: {
        url: { type: 'string' },
        title: { type: 'string' },
        snippet: { type: 'string' },
        relevance: { enum: ['high', 'medium', 'low'] },
      },
    } },
  },
}
const EXTRACT_SCHEMA = {
  type: 'object', required: ['claims', 'sourceQuality'],
  properties: {
    sourceQuality: { enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
    publishDate: { type: 'string' },
    claims: { type: 'array', maxItems: 5, items: {
      type: 'object', required: ['claim', 'quote', 'importance'],
      properties: {
        claim: { type: 'string' },
        quote: { type: 'string' },
        importance: { enum: ['central', 'supporting', 'tangential'] },
      },
    } },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['refuted', 'evidence', 'confidence'],
  properties: {
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    confidence: { enum: ['high', 'medium', 'low'] },
    counterSource: { type: 'string' },
  },
}
const REPORT_SCHEMA = {
  type: 'object', required: ['summary', 'findings', 'caveats'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', required: ['claim', 'confidence', 'sources', 'evidence'],
      properties: {
        claim: { type: 'string' },
        confidence: { enum: ['high', 'medium', 'low'] },
        sources: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'string' },
        vote: { type: 'string' },
      },
    } },
    caveats: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

// ───── 去重与抓取槽位状态（跨 searcher 累积）─────
const seen = new Map()
const dupes = []
const budgetDropped = []
const relRank = { high: 0, medium: 1, low: 2 }
let fetchSlots = MAX_FETCH

// ───── 阶段 1：Scope——把问题分解为搜索角度 ─────
phase('Scope')
const scope = await agent(
  '把研究问题分解为互补的搜索角度。\\n\\n' +
  '## 问题\\n' + question + '\\n\\n' +
  '## 任务\\n' +
  '生成 ' + angles + ' 个不同的网络搜索查询，从不同角度覆盖问题。选择适合问题领域的角度。示例：\\n' +
  '- broad/primary 泛/一手 · academic/technical 学术/技术 · recent news 近期新闻 · contrarian/skeptical 反向/怀疑 · practitioner/implementation 实践/实现\\n' +
  '- 医疗：解剖 · 常见原因 · 严重鉴别诊断 · 权威参考 · 红旗信号\\n' +
  '- 技术：最新进展 · 基准 · 局限 · 行业采用 · 成本/权衡\\n\\n' +
  '查询要具体到能命中高信号结果。避免冗余。\\n' +
  '返回：问题（原样或轻度规范化）、1-2 句分解策略、角度列表。\\n\\n仅结构化输出。',
  { label: 'scope', phase: 'Scope', schema: SCOPE_SCHEMA }
)
if (!scope) {
  return { error: 'Scope 子代理未返回结果——无法分解研究问题。' }
}
log('问题: ' + quotedLabel(question))
log('分解为 ' + scope.angles.length + ' 个角度: ' + scope.angles.map(a => quotedLabel(a.label)).join(', '))

// ───── 提示词模板 ─────
const SEARCH_PROMPT = angle =>
  '## 网络搜索：' + angle.label + '\\n\\n' +
  '研究问题：' + quotedLabel(question) + '\\n\\n' +
  '你的角度：**' + angle.label + '** — ' + (angle.rationale || '') + '\\n' +
  '搜索查询：\`' + angle.query + '\`\\n\\n' +
  '## 任务\\n用 web_search 执行上面的查询（或精炼版本）。返回最相关的 4-6 条结果。\\n' +
  '按与原始问题的相关性排序（不只是查询相关性）。跳过明显的 SEO 垃圾/内容农场。\\n' +
  '每条结果附简短片段说明为何相关。\\n\\n仅结构化输出。'
const FETCH_PROMPT = (source, angle) =>
  '## 来源提取\\n\\n' +
  '研究问题：' + quotedLabel(question) + '\\n\\n' +
  '抓取并提取此来源的关键主张：\\n' +
  '**URL:** ' + source.url + '\\n**标题:** ' + source.title + '\\n**发现途径:** ' + angle + ' 搜索\\n\\n' +
  '## 任务\\n1. 用 web_fetch 获取页面内容。\\n' +
  '2. 评估来源质量：primary 原始研究/机构？secondary 二手报道？blog 博客/观点？forum 论坛？unreliable 不可靠？\\n' +
  '3. 提取 2-5 条与研究问题相关的可证伪主张。每条必须：\\n' +
  '   - 是具体、可核查的陈述（不是模糊泛泛之谈）\\n' +
  '   - 附来源原文的直接引语作为支撑\\n' +
  '   - 标注 central/supporting/tangential 与问题的相关度\\n' +
  '4. 记录发布日期（如有）。\\n\\n' +
  '抓取失败或页面无关/付费墙：返回 claims: [] 和 sourceQuality: "unreliable"。\\n\\n仅结构化输出。'
const VERIFY_PROMPT = (claim, v) =>
  '## 对抗主张验证（投票者 ' + (v + 1) + '/' + VOTES_PER_CLAIM + '）\\n\\n' +
  '保持怀疑。尝试驳倒此主张。≥' + REFUTATIONS_REQUIRED + '/' + VOTES_PER_CLAIM + ' 的驳倒票将杀死它。\\n\\n' +
  '## 研究问题\\n' + question + '\\n\\n' +
  '## 审查中的主张\\n"' + claim.claim + '"\\n\\n' +
  '**来源:** ' + claim.sourceUrl + ' (' + claim.sourceQuality + ')\\n' +
  '**支撑引语:** "' + claim.quote + '"\\n\\n' +
  '## 检查清单\\n' +
  '1. 主张是否真的被引语支撑，还是过度解读/误读？\\n' +
  '2. 用 web_search 搜索反驳证据——是否有可信来源质疑或严重限定此主张？\\n' +
  '3. 来源质量是否足以支撑主张的强度？（非常规主张需要一手来源）\\n' +
  '4. 主张是否过时？（检查日期——快变领域里的旧主张可疑）\\n' +
  '5. 这是营销话术/新闻稿/精挑基准/论坛臆测吗？\\n\\n' +
  '**refuted=true** 当：引语不支撑 / 被反驳 / 强主张配低质来源 / 过时 / 营销话术。\\n' +
  '**refuted=false** 仅当：主张证据充分、时效内、来源质量与主张强度匹配。\\n' +
  '不确定时默认 refuted=true。\\n\\n仅结构化输出。证据必须具体。'

// ───── 阶段 2/3：pipeline(Search → URL 去重 → Fetch+Extract)，无屏障 ─────
phase('Search')
const searchResults = await pipeline(
  scope.angles,
  angle => agent(SEARCH_PROMPT(angle), {
    label: 'search:' + stripLabelChars(angle.label), phase: 'Search', schema: SEARCH_SCHEMA,
  }).then(r => {
    if (!r) return null
    log(quotedLabel(angle.label) + ': ' + r.results.length + ' 条结果')
    return { angle: angle.label, results: r.results }
  }),
  searchResult => {
    // stage 1 可为 null（用户跳过或子代理终态错误）——按运行时 null 转发契约
    // 原样传递，由末尾 searchResults.flat().filter(Boolean) 兜底。
    if (!searchResult) return null
    const sorted = [...searchResult.results].sort((a, b) => relRank[a.relevance] - relRank[b.relevance])
    const novel = sorted.filter(r => {
      const key = normURL(r.url)
      if (seen.has(key)) {
        dupes.push({ ...r, angle: searchResult.angle, dupOf: seen.get(key) })
        return false
      }
      if (fetchSlots <= 0 && relRank[r.relevance] >= 1) {
        budgetDropped.push({ ...r, angle: searchResult.angle })
        return false
      }
      seen.set(key, { angle: searchResult.angle, title: r.title })
      fetchSlots--
      return true
    })
    if (novel.length < searchResult.results.length) {
      log(quotedLabel(searchResult.angle) + ': ' + novel.length + ' 条新来源（过滤 ' + (searchResult.results.length - novel.length) + ' 条）')
    }
    return parallel(
      novel.map(source => () => {
        // 裸 fetch:<host> 标签断言真实抓取主机，因此仅在捕获主机是原样、完整、
        // 未截断、严格 ASCII 主机名且清洗未动它时输出。任何偏离都走与标题回退
        // 相同的引号+省略号辅助——有损显示值永远不能冒充真实主机：非 ASCII
        // （如西里尔 "аmazon.com" 这种 IDN 同形字，本 realm 无 punycode）、非法
        // 主机字符、长到需要截断的主机（裸前缀可显示可信域而真实主机不同）、
        // 或清洗改动过的主机（删控制符会把 exa<ctrl>mple.com 变成 example.com，
        // 那并不是真实主机）。
        const capturedHost = String(source.url).match(URL_HOST_PATTERN)?.[1] ?? ''
        const host = capturedHost.toLowerCase()
        const cleanHost = stripLabelChars(host)
        const isCleanBareHost = cleanHost === host && host !== '' && Array.from(host).length <= LABEL_CAP && STRICT_HOST.test(host)
        const hostLabel = cleanHost === '' ? '' : isCleanBareHost ? host : quotedLabel(host)
        const sourceLabel = hostLabel || (stripLabelChars(source.title).trim() && quotedLabel(source.title)) || 'unknown'
        return agent(FETCH_PROMPT(source, searchResult.angle), {
          label: 'fetch:' + sourceLabel,
          phase: 'Fetch',
          schema: EXTRACT_SCHEMA,
        }).then(ext => {
          // 用户跳过 → null；丢弃（由 searchResults.flat().filter(Boolean) 过滤）
          // 而不是抛进 .catch() 误标为 "unreliable"。
          if (!ext) return null
          return {
            url: source.url, title: source.title, angle: searchResult.angle,
            sourceQuality: ext.sourceQuality, publishDate: ext.publishDate,
            claims: ext.claims.map(c => ({ ...c, sourceUrl: source.url, sourceQuality: ext.sourceQuality })),
          }
        }).catch(e => {
          log('抓取失败: ' + quotedLabel(source.url) + ' — ' + (e.message || e))
          return { url: source.url, title: source.title, angle: searchResult.angle, sourceQuality: 'unreliable', claims: [] }
        })
      }),
    )
  },
)
const allSources = searchResults.flat().filter(Boolean)
const allClaims = allSources.flatMap(s => s.claims)
// 按 importance → sourceQuality 排序，取前 MAX_VERIFY_CLAIMS 验证（成本上限）。
const impRank = { central: 0, supporting: 1, tangential: 2 }
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }
const rankedClaims = [...allClaims]
  .sort((a, b) => (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]))
  .slice(0, MAX_VERIFY_CLAIMS)
log('抓取 ' + allSources.length + ' 个来源 → ' + allClaims.length + ' 条主张 → 验证前 ' + rankedClaims.length + ' 条')
if (rankedClaims.length === 0) {
  return {
    question,
    summary: '未提取到主张。抓取了 ' + allSources.length + ' 个来源，全部为空/失败。' + dupes.length + ' 个 URL 重复，' + budgetDropped.length + ' 个超出预算丢弃。',
    findings: [], refuted: [], unverified: [],
    sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length })),
    stats: { angles: scope.angles.length, sourcesFetched: allSources.length, claimsExtracted: 0, claimsVerified: 0, confirmed: 0, killed: 0, unverified: 0, afterSynthesis: 0, urlDupes: dupes.length, budgetDropped: budgetDropped.length, agentCalls: 1 + scope.angles.length + allSources.length },
  }
}

// ───── 阶段 4：Verify——每主张 3 票对抗 ─────
// 此处的屏障是有意为之——验证前必须凑齐完整主张池。
phase('Verify')
const voted = (await parallel(
  rankedClaims.map(claim => () =>
    parallel(
      Array.from({ length: VOTES_PER_CLAIM }, (_, v) => () =>
        agent(VERIFY_PROMPT(claim, v), {
          label: 'v' + v + ':' + stripLabelChars(claim.claim).slice(0, 40),
          phase: 'Verify',
          schema: VERDICT_SCHEMA,
        }),
      ),
    ).then(verdicts => {
      // 票可为 null（用户跳过或子代理错误）——按未投票计。三态判定
      // （基础设施错误不得读成「被驳倒」）：
      //   survives  —— 有效票达 quorum 且驳倒票不足 REFUTATIONS_REQUIRED
      //   isRefuted —— ≥REFUTATIONS_REQUIRED 张驳倒票（按实据裁定）
      //   其他      —— unverified：有效票不足无法裁定（验证代理出错）
      const valid = verdicts.filter(Boolean)
      const refuted = valid.filter(v => v.refuted).length
      const errored = VOTES_PER_CLAIM - valid.length
      const survives = valid.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED
      const isRefuted = refuted >= REFUTATIONS_REQUIRED
      const mark = survives ? '✓' : isRefuted ? '✗' : '?'
      log('"' + stripLabelChars(claim.claim).slice(0, 50) + '…": ' + (valid.length - refuted) + '-' + refuted + (errored > 0 ? '（' + errored + ' 票失败）' : '') + ' ' + mark)
      return { ...claim, verdicts: valid, refutedVotes: refuted, erroredVotes: errored, survives, isRefuted }
    }),
  ),
)).filter(Boolean)
const confirmed = voted.filter(c => c.survives)
const killed = voted.filter(c => c.isRefuted)
const unverified = voted.filter(c => !c.survives && !c.isRefuted)
log('验证完成: ' + voted.length + ' 条主张 → ' + confirmed.length + ' 条确认, ' + killed.length + ' 条驳倒, ' + unverified.length + ' 条未验证')
const toRefuted = c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes, source: c.sourceUrl })
const toUnverified = c => ({ claim: c.claim, erroredVotes: c.erroredVotes, validVotes: c.verdicts.length, source: c.sourceUrl })
if (confirmed.length === 0) {
  // 区分「按实据驳倒」与「无法验证（基础设施错误）」。所有验证代理都失败
  // （限流/API 错误）的运行是基础设施失败而非研究结论——如实报告，让用户
  // 知道该重试而不是得出「研究无果」。
  let summary
  if (killed.length === 0 && unverified.length > 0) {
    summary = '无法验证任何主张——全部 ' + unverified.length + ' 个验证组失败（可能是限流或 API 错误）。这是基础设施失败，不是研究结论。原始提取主张见下；请重试或人工验证。'
  } else if (unverified.length > 0) {
    summary = killed.length + ' 条主张被对抗验证驳倒；' + unverified.length + ' 条无法验证（验证代理失败）。没有主张存活。研究无结论。'
  } else {
    summary = '全部 ' + killed.length + ' 条主张被对抗验证驳倒。研究无结论——来源可能质量低或主张夸大。'
  }
  return {
    question,
    summary,
    findings: [],
    refuted: killed.map(toRefuted),
    unverified: unverified.map(toUnverified),
    sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length })),
    stats: { angles: scope.angles.length, sourcesFetched: allSources.length, claimsExtracted: allClaims.length, claimsVerified: voted.length, confirmed: 0, killed: killed.length, unverified: unverified.length, afterSynthesis: 0, urlDupes: dupes.length, budgetDropped: budgetDropped.length, agentCalls: 1 + scope.angles.length + allSources.length + (voted.length * VOTES_PER_CLAIM) + 1 },
  }
}

// ───── 阶段 5：Synthesize——决策式综合 ─────
phase('Synthesize')
const confRank = { high: 0, medium: 1, low: 2 }
const block = confirmed.map((c, i) => {
  const best = c.verdicts.filter(v => !v.refuted).sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0]
  return '### [' + i + '] ' + c.claim + '\\n' +
    '票数: ' + (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes + ' · 来源: ' + c.sourceUrl + ' (' + c.sourceQuality + ')\\n' +
    '引语: "' + c.quote + '"\\n验证证据（' + best.confidence + '）: ' + best.evidence + '\\n'
}).join('\\n')
const killedBlock = killed.length > 0
  ? '\\n## 被驳倒的主张（透明公开）\\n' +
    killed.map(c => '- "' + c.claim + '"（' + c.sourceUrl + '，票数 ' + (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes + '）').join('\\n')
  : ''
const unverifiedBlock = unverified.length > 0
  ? '\\n## 未验证的主张（' + unverified.length + ' 条——验证代理失败；既未确认也未驳倒）\\n' +
    unverified.map(c => '- "' + c.claim + '"（' + c.sourceUrl + '，' + c.erroredVotes + '/' + VOTES_PER_CLAIM + ' 票失败）').join('\\n') +
    '\\n\\n在 caveats 中提及 ' + unverified.length + ' 条主张因基础设施错误无法验证。'
  : ''
const report = await agent(
  '## 综合：研究报告\\n\\n' +
  '**问题：** ' + question + '\\n\\n' +
  confirmed.length + ' 条主张通过了 ' + VOTES_PER_CLAIM + ' 票对抗验证。合并语义重复并综合。\\n\\n' +
  '## 已确认主张\\n' + block + '\\n' + killedBlock + unverifiedBlock + '\\n\\n' +
  '## 指令\\n' +
  '1. 识别表述相同的主张——合并它们，合并来源。\\n' +
  '2. 把相关主张归组成连贯发现。每条发现应直接回应研究问题。\\n' +
  '3. 按发现分配 confidence：high（多个一手来源、票数一致）、medium（二手来源或分裂票）、low（单来源或博客质量）。\\n' +
  '4. 写 3-5 句执行摘要回答研究问题。\\n' +
  '5. 记录 caveats：什么不确定、哪些来源弱、什么时效性适用。\\n' +
  '6. 列出 2-4 个浮现但未回答的开放问题。\\n\\n仅结构化输出。',
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT_SCHEMA }
)
if (!report) {
  // 综合被跳过/出错——原样挽救已确认主张，而不是在 report.findings 上抛错丢弃整个运行。
  return {
    question,
    summary: '综合步骤被跳过或失败——返回 ' + confirmed.length + ' 条未合并的已确认主张。',
    findings: [],
    confirmed: confirmed.map(c => ({ claim: c.claim, source: c.sourceUrl, quote: c.quote, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes })),
    refuted: killed.map(toRefuted),
    unverified: unverified.map(toUnverified),
    sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length })),
    stats: { angles: scope.angles.length, sourcesFetched: allSources.length, claimsExtracted: allClaims.length, claimsVerified: voted.length, confirmed: confirmed.length, killed: killed.length, unverified: unverified.length, afterSynthesis: 0, urlDupes: dupes.length, budgetDropped: budgetDropped.length, agentCalls: 1 + scope.angles.length + allSources.length + (voted.length * VOTES_PER_CLAIM) + 1 },
  }
}
return {
  question,
  ...report,
  refuted: killed.map(toRefuted),
  unverified: unverified.map(toUnverified),
  sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length })),
  stats: {
    angles: scope.angles.length,
    sourcesFetched: allSources.length,
    claimsExtracted: allClaims.length,
    claimsVerified: voted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    unverified: unverified.length,
    afterSynthesis: report.findings.length,
    urlDupes: dupes.length,
    budgetDropped: budgetDropped.length,
    agentCalls: 1 + scope.angles.length + allSources.length + (voted.length * VOTES_PER_CLAIM) + 1,
  },
}`;
}

/**
 * Generate a codebase audit workflow.
 *
 * `scope` and each `checks` entry are user-supplied strings that get baked
 * directly into the generated script's source (unlike the runtime-args-driven
 * generators above), so every one is embedded via JSON.stringify — a proper JS
 * string literal that can't be broken out of by a quote, backslash, or
 * backtick in the value. Only the human-readable `meta.description` is
 * truncated for display; the operative `scope` used by the agents is always
 * the full, untruncated value.
 */
export function generateCodebaseAuditWorkflow(scope: string, checks: string[]): string {
  const displayScope = scope.length > 60 ? `${scope.slice(0, 60)}…` : scope;
  const checkAgents = checks
    .map((check, i) => {
      const label =
        check
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 20) || `check-${i + 1}`;
      const prompt = `Audit the following concern across the codebase at: ${scope}

Concern: ${check}

Method (use in order):
1. Call the codegraph_explore TOOL with a plain-text query about this concern's area (symbols, callers, callees, state) to map the symbols and blast radius; only if that tool is unavailable, run "bash: codegraph explore <query>" as one clean command (no pipes/grep, the CLI misparses them). If codegraph is unavailable or has no index, fall back to glob/grep/read.
2. Read the relevant files and trace call paths across files; use lsp (hover/references) to locate symbols precisely when available.
3. Verify every finding against actual code; cite file:line evidence. Report only confirmed findings; mark unverifiable claims as uncertain.`;
      return `  () => agent(${JSON.stringify(prompt)}, { label: ${JSON.stringify(label)} }),`;
    })
    .join("\n");

  return `export const meta = {
  name: 'codebase_audit',
  description: ${JSON.stringify(`代码库审计：${displayScope}`)},
  phases: [
    { title: 'Individual Checks' },
    { title: 'Cross-Validation' },
    { title: 'Report' },
  ],
};

phase('Individual Checks');
const scope = ${JSON.stringify(scope)};
const findings = await parallel([
${checkAgents}
]);

phase('Cross-Validation');
const validated = await agent(
  'Cross-validate these audit findings. Remove false positives and confirm real issues:\\n' +
  JSON.stringify(findings),
  { label: 'validator' }
);

phase('Report');
const report = await agent(
  'Generate a prioritized audit report with actionable recommendations:\\n' + validated,
  { label: 'report-writer' }
);

return { findings, validated, report };`;
}
