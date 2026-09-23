/**
 * skillregistry.js — v99 "loopwise" skill discovery + curated GitHub repos.
 *
 * v98 had 103 bundled skills and a verify-gated HTTPS downloader
 * (skilldl.js) — but discovery was prompt-name-only and the user had to
 * already KNOW the exact URL of anything else. This module adds the missing
 * surfaces, data-only and honest:
 *
 *   - searchSkills(): local index search (token scoring over names +
 *     descriptions) — `forge skill search <query>`
 *   - SKILL_REPOS: a curated list of the best-known skill repositories on
 *     GitHub, with example skills and raw SKILL.md URLs ready for
 *     `forge skill download <url>` — `forge skill recommend [query]`
 *
 * Nothing here downloads anything by itself: recommendation returns URLs;
 * downloading still goes through the ONE trusted path (skilldl.js:
 * SSRF-guarded pinned fetch, ≤8MB, verify → activate lifecycle). No
 * telemetry, no remote queries, no invented repos.
 *
 * ── v147: the URLs are checked now ──────────────────────────────────────────
 * This file used to say "URLs are hints, not promises — a moved branch fails
 * the download honestly". Checking them found that SEVEN OF TEN were already
 * 404, so `forge skill recommend` was mostly handing out links that fail at
 * download time. "Honest failure" is only honest if someone looks.
 *
 * What changed: every example carries `checked`, the date its URL was last
 * confirmed to return 200. `verifyRegistry()` re-checks them all, and
 * `tests/test-skill-registry.mjs` runs it when FORGE_NET_TESTS=1 — off by
 * default, because a suite that fails when GitHub has a bad minute is a suite
 * people learn to ignore.
 *
 * What the check could NOT establish is also recorded. `anthropics/skills`
 * had simply MOVED (document-skills/ → skills/) and its new paths verify. Two
 * other repos answered 404 on every path tried — but a failed guess is not
 * proof a repo is gone, and `anthropics/skills` is the proof of that. Their
 * dead URLs are out of `examples` (a 404 is worse than nothing: it fails at
 * download) and preserved in `stale` with the date, so the next person starts
 * from what was tried rather than from scratch.
 */

/** Verified by fetching each URL on this date. See `verifyRegistry()`. */
export const REGISTRY_CHECKED = "2026-09-23"

/**
 * Curated skill repositories. Every entry in `examples` lists a RAW SKILL.md
 * URL (raw.githubusercontent.com) that `forge skill download` accepts
 * directly, and every one of them returned 200 on REGISTRY_CHECKED.
 *
 * `stale` holds URLs that were in this list and no longer resolve, with what
 * is known about them. They are kept out of `examples` so nothing recommends
 * them, and kept in the file so the next check does not re-derive the same
 * dead ends.
 */
export const SKILL_REPOS = Object.freeze([
  {
    repo: "obra/superpowers",
    desc: "the original process-skill pack: TDD, systematic debugging, planning, code review, git worktrees",
    license: "MIT",
    bundled: "13 of its skills ship bundled with forge already",
    examples: [
      { name: "writing-skills", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/writing-skills/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "systematic-debugging", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "test-driven-development", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "using-git-worktrees", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/using-git-worktrees/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "subagent-driven-development", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "verification-before-completion", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/verification-before-completion/SKILL.md", checked: REGISTRY_CHECKED },
    ],
  },
  {
    repo: "anthropics/skills",
    desc: "Anthropic's official skills: document processing (docx/pdf/pptx/xlsx), brand voice, artifacts, MCP builder",
    license: "varies — check the repo",
    bundled: "forge bundles its own document skills; this is the upstream source",
    // v147: every URL here was `document-skills/<name>/SKILL.md` and every one
    // 404'd. The repo had reorganized to `skills/<name>/SKILL.md`. Re-checked
    // and expanded from three entries to the full verified set.
    examples: [
      { name: "docx", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "pdf", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "pptx", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/pptx/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "xlsx", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/xlsx/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "mcp-builder", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/mcp-builder/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "skill-creator", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "webapp-testing", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/webapp-testing/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "brand-guidelines", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/brand-guidelines/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "canvas-design", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/canvas-design/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "internal-comms", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/internal-comms/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "theme-factory", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/theme-factory/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "algorithmic-art", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/algorithmic-art/SKILL.md", checked: REGISTRY_CHECKED },
      { name: "slack-gif-creator", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/slack-gif-creator/SKILL.md", checked: REGISTRY_CHECKED },
    ],
    stale: [
      { name: "docx", url: "https://raw.githubusercontent.com/anthropics/skills/main/document-skills/docx/SKILL.md", note: "404 — the repo moved document-skills/ to skills/; replaced above", checked: REGISTRY_CHECKED },
    ],
  },
  {
    // v147 — the cloud/IaC entry. Verified: the SKILL.md is at the repository
    // ROOT, not under skills/, and it is a real Agent Skill (YAML frontmatter
    // with name + description, a workflow body).
    repo: "LukasNiessen/terrashark",
    desc: "Terraform/OpenTofu infrastructure-as-code across AWS, Azure and GCP: identity churn, secret exposure, blast radius, CI drift and compliance gates",
    license: "check the repo",
    bundled: "not bundled — the only cloud/IaC entry in this list",
    examples: [
      { name: "terrashark", url: "https://raw.githubusercontent.com/LukasNiessen/terrashark/main/SKILL.md", checked: REGISTRY_CHECKED },
    ],
  },
  {
    repo: "Egonex-AI/Understand-Anything",
    desc: "understanding agents: chat/dashboard/diff/domain/figma/knowledge analysis packs",
    license: "check the repo",
    bundled: "10 of its understand-* skills ship bundled with forge already",
    // v147: both recorded URLs 404, and `skills/`, bare and `Skills/` layouts
    // were tried without a hit. That is a failed GUESS, not proof the repo is
    // gone — anthropics/skills 404'd the same way and had merely moved — so
    // the entry stays for attribution with nothing recommendable in it.
    examples: [],
    stale: [
      { name: "understand-domain", url: "https://raw.githubusercontent.com/Egonex-AI/Understand-Anything/main/skills/understand-domain/SKILL.md", note: "404; skills/, bare and Skills/ layouts all missed on main and master", checked: REGISTRY_CHECKED },
      { name: "understand-figma", url: "https://raw.githubusercontent.com/Egonex-AI/Understand-Anything/main/skills/understand-figma/SKILL.md", note: "404, as above", checked: REGISTRY_CHECKED },
    ],
  },
  {
    repo: "zai-org/GLM-Skills",
    desc: "GLM agent skills: media generation/understanding, web search/reader, full-stack dev",
    license: "check the repo",
    bundled: "the z-ai media skills bundled with forge originate here",
    examples: [],
    stale: [
      { name: "web-search", url: "https://raw.githubusercontent.com/zai-org/GLM-Skills/main/skills/web-search/SKILL.md", note: "404; skills/, bare and web_search layouts all missed on main and master", checked: REGISTRY_CHECKED },
      { name: "image-generation", url: "https://raw.githubusercontent.com/zai-org/GLM-Skills/main/skills/image-generation/SKILL.md", note: "404, as above", checked: REGISTRY_CHECKED },
    ],
  },
])

/**
 * Every live example URL in the registry, flat. The thing to verify.
 */
export function registryUrls() {
  return SKILL_REPOS.flatMap((r) => r.examples.map((e) => ({ repo: r.repo, name: e.name, url: e.url, checked: e.checked ?? null })))
}

/**
 * Re-check every live URL and report what is still there.
 *
 * The ONLY function in this module that touches the network, and it is never
 * called by the CLI — `forge skill recommend` stays pure data. It exists for
 * the maintainer and for `tests/test-skill-registry.mjs` under
 * FORGE_NET_TESTS=1, because the alternative is what v147 found: a curated
 * list where seven of ten links had quietly died.
 *
 * Goes through `pinnedFetch` like everything else that leaves this process —
 * imported lazily so the network stack is not on the path of a module the CLI
 * loads to print a list.
 *
 * @returns {Promise<{ok: boolean, results: Array<{repo, name, url, status, ok}>}>}
 */
export async function verifyRegistry({ timeoutMs = 15000, concurrency = 4 } = {}) {
  const { pinnedFetch } = await import("./netguard.js")
  const targets = registryUrls()
  const results = []
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= targets.length) return
      const t = targets[i]
      let status = 0
      try {
        // HEAD is not reliably served by raw.githubusercontent, so this is a
        // GET with a tight byte cap: enough to prove the file is there without
        // pulling every SKILL.md in the list into memory.
        const res = await pinnedFetch(t.url, { method: "GET", timeoutMs, totalTimeoutMs: timeoutMs, maxBytes: 64 * 1024 })
        status = res.status
      } catch (e) {
        // A cap hit means the file EXISTS and is bigger than the cap, which is
        // the answer we wanted; anything else is a real failure.
        status = /ETOOLARGE|too large/i.test(String(e?.message ?? e)) ? 200 : 0
      }
      results.push({ ...t, status, ok: status === 200 })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  results.sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name))
  return { ok: results.every((r) => r.ok), results }
}

/** GitHub repository-search URL for a topic — a hint for humans, never fetched by forge. */
export function githubSearchUrl(query) {
  const q = encodeURIComponent(`${query ?? ""} SKILL.md`.trim())
  return `https://github.com/search?q=${q}&type=repositories`
}

/**
 * Local skill search over an index ({name, desc, path} entries — the exact
 * shape skills.js indexSkills produces). Deterministic token scoring:
 * name-prefix > name-contains > description-contains > token overlap.
 */
export function searchSkills(query, index = [], { limit = 8 } = {}) {
  const q = String(query ?? "").trim().toLowerCase()
  if (!q) return []
  const tokens = q.split(/\s+/).filter(Boolean)
  const scored = []
  for (const s of index || []) {
    if (!s || !s.name) continue
    const name = String(s.name).toLowerCase()
    const desc = String(s.desc ?? "").toLowerCase()
    let score = 0
    if (name === q) score += 100
    else if (name.startsWith(q)) score += 60
    else if (name.includes(q)) score += 40
    if (desc.includes(q)) score += 20
    let hits = 0
    for (const t of tokens) {
      if (name.includes(t)) hits++
      else if (desc.includes(t)) hits += 0.5
    }
    score += hits * 8
    if (score > 0) scored.push({ name: s.name, desc: s.desc ?? "", path: s.path ?? null, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit)
}

/**
 * Recommend curated repos for a query (stemmed token overlap on
 * repo/desc/examples); no query → all repos. Pure data, ranked
 * deterministically. The stemmer is deliberately crude (plural/gerund
 * endings) — it widens recall ("testing" ↔ "test-driven") without any
 * external dependency.
 */
const stem = (w) => String(w).toLowerCase().replace(/(ings?|ed|es|s)$/, "")
export function recommendRepos(query = "") {
  const q = String(query ?? "").trim().toLowerCase()
  if (!q) return SKILL_REPOS.map((r) => ({ repo: r.repo, desc: r.desc, examples: r.examples.slice(0, 3), score: 0 }))
  const tokens = q.split(/\s+/).filter(Boolean).map(stem).filter((t) => t.length > 2)
  const scored = []
  for (const r of SKILL_REPOS) {
    const words = `${r.repo} ${r.desc} ${r.examples.map((e) => e.name).join(" ")}`.toLowerCase().split(/[^a-z0-9]+/).map(stem)
    const wordSet = new Set(words)
    const score = tokens.reduce((acc, t) => acc + (wordSet.has(t) ? 1 : words.some((w) => w.startsWith(t) && t.length >= 4) ? 1 : 0), 0)
    if (score > 0) scored.push({ repo: r.repo, desc: r.desc, examples: r.examples.slice(0, 3), score })
  }
  return scored.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo))
}
