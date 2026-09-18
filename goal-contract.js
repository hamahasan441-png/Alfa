/** Forge semantic goal/constraint contract — v122.2. */
import crypto from 'node:crypto'

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
