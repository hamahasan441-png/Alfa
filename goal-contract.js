/** Forge semantic goal/constraint contract — v122.2. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const STOP = new Set(['the','a','an','and','or','to','of','in','on','for','with','from','that','this','is','are','be','as','it','all','do','not','must','should','can','will'])
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200)
const tokens = s => [...new Set(clean(s).toLowerCase().replace(/[^\p{L}\p{N}_./:-]+/gu, ' ').split(/\s+/).filter(x => x && !STOP.has(x)).slice(0, 160))]
const fp = s => crypto.createHash('sha256').update(clean(s)).digest('hex').slice(0, 16)

function constraints(text) {
  const t = clean(text)
  const out = []
  const patterns = [
    [/\bmust\b[^.;,]*/gi, 'must'], [/\bneed(?:s)?\b[^.;,]*/gi, 'need'], [/\bwithout\b[^.;,]*/gi, 'without'],
    [/\bpreserv(?:e|ing|es?)\b[^.;,]*/gi, 'preserve'], [/\bnever\b[^.;,]*/gi, 'never'], [/\bdo not\b[^.;,]*/gi, 'do-not'],
    [/\bsecurity\b[^.;,]*/gi, 'security'], [/\btest(?:s|ing)?\b[^.;,]*/gi, 'test'],
  ]
  for (const [re, kind] of patterns) for (const m of t.matchAll(re)) out.push({ kind, text: clean(m[0]) })
  return [...new Map(out.map(x => [x.kind + ':' + x.text.toLowerCase(), x])).values()].slice(0, 40)
}

export function createGoalContract(original = '') {
  const history = [{ version: 1, text: clean(original), fingerprint: fp(original), at: Date.now(), source: 'user' }]
  let current = history[0]
  function compare(next) {
    const text = clean(next)
    const A = new Set(tokens(current.text)), B = new Set(tokens(text))
    const union = new Set([...A, ...B])
    let overlap = 1
    if (union.size) overlap = [...A].filter(x => B.has(x)).length / union.size
    const oldC = constraints(current.text)
    const newC = constraints(text)
    const newText = new Set(newC.map(x => x.kind + ':' + x.text.toLowerCase()))
    const droppedConstraints = oldC.filter(x => !newText.has(x.kind + ':' + x.text.toLowerCase()))
    const semanticDrift = Number((1 - overlap).toFixed(4))
    return { semanticDrift, level: semanticDrift >= 0.65 ? 'HIGH' : semanticDrift >= 0.35 ? 'MEDIUM' : 'LOW', droppedConstraints, originalFingerprint: history[0].fingerprint, currentFingerprint: current.fingerprint, nextFingerprint: fp(text), tokenOverlap: Number(overlap.toFixed(4)), changed: text !== current.text }
  }
  function revise(next, meta = {}) {
    const cmp = compare(next)
    if (!cmp.changed) return { changed: false, ...cmp, version: current.version }
    const rec = { version: history.length + 1, text: clean(next), fingerprint: cmp.nextFingerprint, at: Date.now(), source: meta.source || 'user', reason: meta.reason || 'changed-instruction' }
    history.push(rec); current = rec
    return { changed: true, ...cmp, version: rec.version }
  }
  return { original: () => history[0], current: () => current, compare, revise, history: () => history.slice(), snapshot: () => ({ original: history[0], current, history: history.slice() }) }
}

/**
 * V6 — the DURABLE goal contract a task record keeps (taskstate.setGoal).
 * Derived from the objective's own words — every field says it was derived,
 * and nothing here is invented: constraints/prohibitions/deliverables are
 * sentences or phrases the objective actually contains; acceptance criteria
 * are its "should/must/so that/until" clauses; ambiguities are its questions
 * and either/or phrasings. `interpretation` starts as the original text and
 * moves only through an explicit GOAL_REINTERPRETATION.
 */
export function deriveGoalContract(objective = "") {
  const text = clean(objective)
  const cons = constraints(text)
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean)
  const pick = (re) => [...new Set(sentences.filter((x) => re.test(x)).map((x) => x.slice(0, 200)))].slice(0, 12)
  return {
    original: text,
    fingerprint: fp(text),
    derived: true,
    constraints: cons.filter((c) => !["never", "do-not", "without"].includes(c.kind)).map((c) => c.text),
    prohibited: cons.filter((c) => ["never", "do-not", "without"].includes(c.kind)).map((c) => c.text),
    acceptance: pick(/\b(should|must|so that|until|ensure|make sure|verify|pass(es)?)\b/i).filter((x) => !x.endsWith("?")),
    deliverables: [...new Set((text.match(/[\w./-]+\.(?:js|mjs|cjs|ts|tsx|py|go|rs|java|rb|md|json|ya?ml|sh|toml)\b/g) ?? []))].slice(0, 20),
    ambiguities: pick(/\?|\b(either|or maybe|not sure|tbd|unclear)\b/i),
    interpretation: text,
  }
}

/**
 * V7 — the file paths the objective FORBIDS changing, deterministically: a
 * sentence with a negation ("do not", "don't", "never", "must not",
 * "without") AND a change verb (change/modify/edit/touch/delete/remove/
 * rewrite/alter), naming a path. Nothing else is read as a prohibition — a
 * rule that could misread prose must not be able to hold a run.
 */
export function prohibitedTargets(objective = "") {
  const text = clean(objective)
  const out = new Set()
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
    if (!/\b(do not|don't|dont|never|must not|mustn't|without)\b/i.test(sentence)) continue
    if (!/\b(chang|modif|edit|touch|delet|remov|rewrit|alter)\w*/i.test(sentence)) continue
    for (const m of sentence.matchAll(/(?:^|[\s`'"(])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8})(?=$|[\s`'",;:)!?]|\.(?:\s|$))/g)) {
      const p = m[1].replace(/^\.\//, "")
      if (/^\d+(\.\d+)+$/.test(p)) continue // a version number, not a path
      out.add(p)
    }
  }
  return [...out].slice(0, 20)
}

/**
 * V7 — watch the files the objective forbids changing: fingerprint them as the
 * run finds them; `changed()` names those that now differ (content, creation
 * or deletion). A run that touched a file and put it back is not in breach.
 */
export function watchProhibited(objective = "", cwd = process.cwd()) {
  const hash = (abs) => { try { return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') } catch { return null } }
  const targets = prohibitedTargets(objective).map((rel) => { const abs = path.resolve(cwd, rel); return { rel, abs, before: hash(abs) } })
  return { targets: targets.map((t) => t.rel), changed: () => targets.filter((t) => hash(t.abs) !== t.before).map((t) => t.rel) }
}
