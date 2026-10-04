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
 * Strategic Core §31 — the COMMANDS the objective forbids, deterministically,
 * by the same standard as prohibitedTargets: a sentence with a negation AND
 * one of a few explicit actions. Each rule maps to the exact command shapes
 * that perform it; anything looser is left to the model, because a rule that
 * could misread prose must not be able to refuse a command.
 *
 *   "don't push" / "do not push to main"          git push
 *   "do not commit" / "without committing"        git commit
 *     (not "don't commit secrets / the .env file" — that is about content)
 *   "do not publish"                              npm|yarn|pnpm publish, cargo
 *                                                 publish, twine upload, poetry
 *                                                 publish, gem push
 *   "don't add/install new dependencies|packages" npm i <pkg>, yarn|pnpm add,
 *                                                 pip install <pkg>, cargo add,
 *                                                 poetry add, go get
 *     (a bare `npm install` / `npm ci` / `pip install -r …` installs what
 *      is already declared, and stays allowed)
 *   "do not run `make deploy`" (backticked)      that command, as a prefix
 *   "do not deploy" / "don't ship to production"  kubectl/helm/terraform apply,
 *                                                 platform deploy CLIs, deploy
 *                                                 scripts, docker push, git push
 *                                                 to a deploy remote (DEPLOY_CMD)
 *   "don't touch the database" / "do not modify   migrations, resets, seeds, and
 *    production data"                             writing SQL through a client
 *                                                 (DB_CMD)
 */
const NEGATION = /\b(do not|don't|dont|never|must not|mustn't|should not|shouldn't|without|avoid)\b/i
const segmentsOf = (cmd) => String(cmd ?? "").split(/&&|\|\||;|\||\n/).map((s) => s.trim().replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "").replace(/\s+/g, " ")).filter(Boolean)
const anySeg = (cmd, re) => segmentsOf(cmd).some((s) => re.test(s))
const PKG_ADD = /^(?:npm\s+(?:install|i|add)\s+(?!-)(?!$)\S|npm\s+(?:install|i)\s+(?:-\S+\s+)+(?!-)\S|yarn\s+add\b|pnpm\s+(?:add|install\s+(?!-)\S)|pip3?\s+install\s+(?!-r\b)(?!--requirement\b)(?!-e\s+\.)(?!\.)(?!-)\S|python3?\s+-m\s+pip\s+install\s+(?!-r\b)(?!-)\S|cargo\s+add\b|poetry\s+add\b|go\s+get\b|gem\s+install\b|bun\s+add\b)/

// commands that deploy: platform CLIs, infrastructure apply, deploy scripts,
// pushing an image or to a deploy remote
const DEPLOY_CMD = /^(?:(?:kubectl|oc)\s+(?:apply|create|replace|rollout|set\s+image|scale|delete)\b|helm\s+(?:install|upgrade|uninstall|rollback)\b|terraform\s+(?:apply|destroy|import)\b|tofu\s+(?:apply|destroy)\b|pulumi\s+(?:up|destroy|refresh)\b|(?:cdk|sam|serverless|sls|eb|fly|flyctl|netlify|firebase|wrangler|railway|render|surge|now)\s+(?:deploy|publish|up)\b|vercel(?:\s|$)(?!.*\b(?:dev|build|pull|env\s+ls|whoami|login)\b)|gcloud\s+(?:app|run|functions)\s+deploy\b|aws\s+(?:cloudformation|deploy|ecs|lambda)\s+(?:deploy|create-deployment|update-service|update-function-code|create-stack|update-stack)\b|az\s+(?:webapp|functionapp|containerapp)\s+(?:deploy|up|update)\b|heroku\s+(?:releases:rollback|container:release|deploy)\b|git\s+push\s+(?:heroku|dokku|production|prod|deploy)\b|docker\s+(?:push|stack\s+deploy|service\s+update)\b|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:deploy|release)(?::\S+)?(?:\s|$)|make\s+(?:deploy|release)(?:\s|$)|(?:\.\/)?deploy(?:\.sh)?(?:\s|$)|ansible-playbook\b|capistrano\b|cap\s+\S+\s+deploy\b)/
// commands that change a database: migrations, resets, seeds, and SQL that
// writes, run through a client
const DB_CMD = /^(?:prisma\s+(?:migrate\s+(?:dev|reset|deploy)|db\s+(?:push|seed|execute))\b|npx\s+prisma\s+(?:migrate\s+(?:dev|reset|deploy)|db\s+(?:push|seed|execute))\b|(?:bin\/)?(?:rails|rake)\s+db:(?:migrate|drop|reset|setup|seed|rollback|schema:load)\b|alembic\s+(?:upgrade|downgrade|stamp)\b|(?:python3?\s+)?manage\.py\s+(?:migrate|flush|loaddata|sqlflush)\b|(?:npx\s+)?(?:knex|sequelize|typeorm|drizzle-kit|db-migrate|migrate)\s+\S*(?:migrat|push|seed|drop|reset|up|down)\S*|flyway\s+(?:migrate|clean|repair|baseline)\b|liquibase\s+(?:update|rollback|drop-all)\b|(?:psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|mongo|redis-cli)\b.*\b(?:drop|truncate|delete|update|insert|alter|create|flushall|flushdb|dropDatabase|deleteMany|updateMany|insertOne|insertMany)\b|(?:dropdb|createdb|pg_restore|mysqldump\s+.*--add-drop)\b)/i

export function prohibitedCommands(objective = "") {
  const text = clean(objective)
  const rules = new Map()
  const add = (id, label, phrase, re) => { if (!rules.has(id)) rules.set(id, { id, label, phrase: phrase.slice(0, 160), test: (cmd) => anySeg(cmd, re) }) }
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
    const neg = NEGATION.exec(sentence)
    if (!neg) continue
    // only what follows the negation, within the same clause
    const after = sentence.slice(neg.index).split(/,\s*(?:but|and then|then|so)\b|\bbut\b/i)[0]
    if (/\bpush(?:es|ing|ed)?\b(?!\s+notifications?)/i.test(after)) add("push", "push to a remote", sentence, /^git\s+(?:-C\s+\S+\s+)?push\b/)
    if (/\bcommit(?:s|ting|ted)?\b/i.test(after) && !/\b(?:secrets?|credentials?|keys?|tokens?|passwords?|node_modules|binar\w*|large files?|generated)\b|\.env\b/i.test(after)) add("commit", "commit", sentence, /^git\s+(?:-C\s+\S+\s+)?commit\b/)
    if (/\bpublish(?:es|ing|ed)?\b/i.test(after)) add("publish", "publish a package", sentence, /^(?:(?:npm|yarn|pnpm|bun)\s+publish\b|cargo\s+publish\b|twine\s+upload\b|poetry\s+publish\b|gem\s+push\b)/)
    if (/\b(?:add|install)(?:s|ing|ed)?\b[^.;]{0,40}\b(?:dependenc|packages?|librar|deps\b|modules?\b)/i.test(after)) add("dependencies", "add a dependency", sentence, PKG_ADD)
    // Strategic Core §21 / Robot §21: two SEMANTIC prohibitions with a
    // deterministic command meaning. "Do not deploy" names no command, but the
    // commands that deploy are a known list; "don't touch the database" /
    // "do not modify production data" likewise map to migration, reset and
    // destructive-SQL commands. A command off these lists is not guessed at.
    // the semantic classes read the prose only: a backticked command is its
    // own exact rule (below), not a mention of "deploy"
    const prose = after.replace(/`[^`]*`/g, " ")
    if (/\b(?:deploy(?:s|ing|ed|ment)?|ship(?:ping)? (?:it )?to (?:prod|production|staging)|release to (?:prod|production))\b/i.test(prose)) add("deploy", "deploy", sentence, DEPLOY_CMD)
    if (/\b(?:database|db|production data|prod data|user data|migrations?|schema)\b/i.test(prose) && /\b(?:touch|modify|change|alter|migrate|drop|reset|delete|wipe|run|apply|write)\w*/i.test(prose)) add("database", "change the database", sentence, DB_CMD)
    for (const m of after.matchAll(/\b(?:run|execute|invoke|use|call)\s+`([^`]{2,120})`/gi)) {
      const lit = m[1].trim().replace(/\s+/g, " ")
      const esc = lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      add(`cmd:${lit}`, `run \`${lit}\``, sentence, new RegExp(`^${esc}(?:\\s|$)`))
    }
  }
  return [...rules.values()].slice(0, 12)
}

/** The first prohibition a command breaks, or null. Never throws. */
export function commandBreaksProhibition(rules = [], command = "") {
  try { return (rules ?? []).find((r) => r.test(command)) ?? null } catch { return null }
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
