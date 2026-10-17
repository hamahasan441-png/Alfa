/** Forge semantic goal/constraint contract — v122.2. */
import { lazyBuiltin, loadBuiltin } from './lazybuiltin.js'
const crypto = lazyBuiltin('crypto') // loaded on first use (lazybuiltin.js)
const fs = loadBuiltin("fs") // node:fs without its ES-module wrapper (lazybuiltin.js)
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
  return prohibitedTargetPhrases(objective).map((x) => x.rel)
}

/** prohibitedTargets with the sentence each path was forbidden in — what a
 *  refusal at the tool quotes back ("the task says not to change X"). */
export function prohibitedTargetPhrases(objective = "") {
  const text = clean(objective)
  const out = new Map()
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
    if (!/\b(do not|don't|dont|never|must not|mustn't|without)\b/i.test(sentence)) continue
    if (!/\b(chang|modif|edit|touch|delet|remov|rewrit|alter)\w*/i.test(sentence)) continue
    for (const m of sentence.matchAll(/(?:^|[\s`'"(])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8})(?=$|[\s`'",;:)\]!?]|\.(?:[\s)\]`'"]|$))/g)) {
      const p = m[1].replace(/^\.\//, "")
      if (/^\d+(\.\d+)+$/.test(p)) continue // a version number, not a path
      if (!out.has(p)) out.set(p, sentence.slice(0, 160))
    }
  }
  return [...out].slice(0, 20).map(([rel, phrase]) => ({ rel, phrase }))
}

/**
 * "Do not write/modify files outside the project" — the task's own write
 * scope, by the same standard as the rules above: a sentence with a negation,
 * a change verb and "outside the project/workspace/repository/working
 * directory"; or an explicit positive scope ("keep all changes inside the
 * project", "stay within the workspace", "only modify files in this repo").
 * "Fix the script that writes outside the project" names no prohibition and
 * is not read as one. Returns { id, label, phrase } or null.
 */
const PROJECT_WORD = String.raw`(?:the\s+|this\s+|your\s+|my\s+|our\s+|its\s+)?(?:current\s+)?(?:project|workspace|repo(?:sitory)?|codebase|working\s+(?:directory|dir|tree|folder|copy)|work\s*tree|project\s+(?:directory|dir|folder|root|tree))\b`
const CHANGE_VERB = String.raw`\b(?:writ|modif|chang|touch|creat|edit|delet|remov|sav|put|add|alter|overwrit|mov|cop)\w*`
export function outsideWriteProhibition(objective = "") {
  const text = clean(objective)
  const negOutside = new RegExp(`${CHANGE_VERB}[^.;]{0,80}?\\boutside\\s+(?:of\\s+)?${PROJECT_WORD}`, "i")
  const keepInside = new RegExp(`\\b(?:keep|confine|restrict|limit)\\s+(?:all\\s+|any\\s+|your\\s+|the\\s+|every\\s+)?(?:changes|edits|writes|modifications|files?|work)\\b[^.;]{0,30}?\\b(?:inside|within|to)\\s+${PROJECT_WORD}`, "i")
  const stayInside = new RegExp(`\\bstay\\s+(?:inside|within|in)\\s+${PROJECT_WORD}`, "i")
  const onlyInside = new RegExp(`\\bonly\\s+(?:ever\\s+)?(?:writ|modif|chang|touch|creat|edit)\\w*\\s+(?:files?\\s+|things?\\s+|code\\s+)?(?:inside|within|in)\\s+${PROJECT_WORD}`, "i")
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
    const neg = NEGATION.exec(sentence)
    if (neg) {
      const after = sentence.slice(neg.index).split(/,\s*(?:but|and then|then|so)\b|\bbut\b/i)[0]
      if (!SOFT_NEGATION.test(after) && negOutside.test(after)) return { id: "outside", label: "write outside the project", phrase: sentence.slice(0, 160) }
    }
    if (keepInside.test(sentence) || stayInside.test(sentence) || onlyInside.test(sentence)) return { id: "outside", label: "write outside the project", phrase: sentence.slice(0, 160) }
  }
  return null
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
 *                                                 poetry add, go get, apt-get /
 *                                                 brew / conda install <pkg> …
 *                                                 (installKind "named")
 *     (a bare `npm install` / `npm ci` / `pip install -r …` installs what
 *      is already declared, and stays allowed under "add"/"new" …)
 *   "do not install dependencies|packages"        … but not under a plain
 *                                                 "do not install": every
 *                                                 package install, declared
 *                                                 or named, is refused
 *   Commands are matched as written AND unwrapped (segmentsOf): `sh -c '…'`,
 *   `env`/`sudo`/`timeout` prefixes, git's global options — so `git -c x=y
 *   commit` is a commit. "Don't forget to push" asks for the push, and holds
 *   nothing (SOFT_NEGATION).
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
const NEGATION_ALL = new RegExp(NEGATION.source, "gi")
// "don't forget to push", "do not hesitate to commit", "never skip
// installing deps" — a negation that ASKS for the action, not a prohibition
const SOFT_NEGATION = /^(?:do not|don't|dont|never|must not|mustn't|should not|shouldn't|avoid|without)\s+(?:ever\s+)?(?:forget|fail|hesitat|neglect|omit|skip|worry|stop|wait)\w*\b/i
const rawSegments = (cmd) => String(cmd ?? "").split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean)
const legacySeg = (s) => s.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "").replace(/\s+/g, " ")

/**
 * One command line → the simple commands it runs, in the shape the rules are
 * written against. Each segment is kept as written (the historical form) AND
 * normalized: wrappers that run a command (`sh -c '…'`, `bash -lc "…"`,
 * `eval …`, `env`, `command`, `sudo -u x`, `timeout 60`, `nohup`, `xargs`,
 * a `( … )` group) are unwrapped, a program path is its name (`/usr/bin/git`
 * → git) and git's global options (`-c k=v`, `-C dir`, `--no-pager`,
 * `--git-dir=…`) are dropped — so `git -c user.name=x commit`, `sh -c 'git
 * push'` and `env git push` are the `git commit` / `git push` a rule names.
 * A script's body is not read (`sh deploy.sh` stays `sh deploy.sh`).
 */
const WRAP_VALUED = { sudo: /^-[ugCDhprtU]$/, doas: /^-[uC]$/, timeout: /^(?:-s|-k|--signal|--kill-after)$/, nice: /^-n$/, ionice: /^-[cnp]$/, env: /^(?:-u|--unset|-C|--chdir)$/, xargs: /^-[ILnPdEsa]$/, stdbuf: /^-[ioe]$/ }
const WRAP_PREFIX = new Set(["command", "builtin", "exec", "nohup", "setsid", "time", "env", "sudo", "doas", "nice", "ionice", "stdbuf", "timeout", "xargs", "unbuffer", "chronic"])
const GIT_VALUED = /^(?:-c|-C|--git-dir|--work-tree|--namespace|--config-env|--exec-path)$/
const unquote = (s) => {
  const t = String(s ?? "").trim()
  const q = t[0]
  if (q !== "'" && q !== '"') return t
  const end = t.indexOf(q, 1)
  return end > 0 ? t.slice(1, end) : t.slice(1)
}
function normalizedSegments(cmd, depth = 0) {
  const out = []
  for (const raw of rawSegments(cmd)) {
    let s = raw
    for (let guard = 0; guard < 12 && s; guard++) {
      s = s.replace(/^[({!]\s*/, "").replace(/\s*[)}]+\s*$/, "").replace(/^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, "").trim()
      const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(s)
      if (!m) break
      const prog = m[1].replace(/^['"]|['"]$/g, "").split("/").pop()
      const rest = m[2] ?? ""
      // `sh -c '<line>'` / `bash -lc "<line>"` / `eval <line>`: the line is the command
      if (depth < 3 && /^(?:ba|z|da|k|a)?sh$/.test(prog)) {
        const c = /(?:^|\s)(?:-[A-Za-z]*c[A-Za-z]*|--command)\s+([\s\S]+)$/.exec(rest)
        if (c) { out.push(...normalizedSegments(unquote(c[1]), depth + 1)); s = ""; break }
      }
      if (depth < 3 && prog === "eval") { out.push(...normalizedSegments(unquote(rest), depth + 1)); s = ""; break }
      if (WRAP_PREFIX.has(prog)) {
        const words = rest.split(/\s+/).filter(Boolean)
        let k = 0
        let durationSeen = false
        while (k < words.length) {
          const w = words[k]
          if (WRAP_VALUED[prog]?.test(w)) { k += 2; continue }
          if (w.startsWith("-") || /^[A-Za-z_]\w*=/.test(w)) { k++; continue }
          if (prog === "timeout" && !durationSeen && /^\d+(?:\.\d+)?[smhd]?$/.test(w)) { durationSeen = true; k++; continue }
          break
        }
        s = words.slice(k).join(" ")
        continue
      }
      if (prog === "git") {
        const words = rest.split(/\s+/).filter(Boolean)
        let k = 0
        while (k < words.length && words[k].startsWith("-")) k += GIT_VALUED.test(words[k]) ? 2 : 1
        s = ["git", ...words.slice(k)].join(" ")
      } else {
        s = [prog, rest].filter(Boolean).join(" ")
      }
      break
    }
    if (s) out.push(s.replace(/\s+/g, " ").trim())
  }
  return out.filter(Boolean)
}
// every form of each segment: as written (the historical match) and normalized
const segmentsOf = (cmd) => [...new Set([...rawSegments(cmd).map(legacySeg), ...normalizedSegments(cmd)])].filter(Boolean)
const anySeg = (cmd, re) => segmentsOf(cmd).some((s) => re.test(s))
const PKG_ADD = /^(?:npm\s+(?:install|i|add)\s+(?!-)(?!$)\S|npm\s+(?:install|i)\s+(?:-\S+\s+)+(?!-)\S|yarn\s+add\b|pnpm\s+(?:add|install\s+(?!-)\S)|pip3?\s+install\s+(?!-r\b)(?!--requirement\b)(?!-e\s+\.)(?!\.)(?!-)\S|python3?\s+-m\s+pip\s+install\s+(?!-r\b)(?!-)\S|cargo\s+add\b|poetry\s+add\b|go\s+get\b|gem\s+install\b|bun\s+add\b)/

/**
 * What a (normalized) command installs: "named" — a package the command
 * names (npm i lodash, pip install -U requests, apt-get install jq, brew
 * install jq, cargo install rg …) — "manifest" — what the project already
 * declares (npm install / npm ci / yarn / pip install -r requirements.txt /
 * poetry install …) — or null. Words, not regexes over prose.
 */
export function installKind(seg) {
  const w = String(seg ?? "").trim().split(/\s+/)
  let p = w[0] ?? ""
  let i = 1
  if (/^python[\d.]*$/.test(p) && w[1] === "-m" && /^pip\d?$/.test(w[2] ?? "")) { p = "pip"; i = 3 }
  if (p === "uv" && w[1] === "pip") { p = "pip"; i = 2 }
  const sub = w[i] ?? ""
  const rest = w.slice(i + 1)
  const operands = (valued = null) => {
    const o = []
    for (let k = 0; k < rest.length; k++) {
      const x = rest[k]
      if (x === "--") continue
      if (x.startsWith("-")) { if (valued && valued.test(x)) k++; continue }
      o.push(x)
    }
    return o
  }
  const namedOr = (kind, valued) => operands(valued).length ? "named" : kind
  switch (p) {
    case "npm": case "npm.cmd":
      if (/^(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall)$/.test(sub)) return namedOr("manifest", /^(?:--prefix|--registry|-w|--workspace|--tag|--cache|--userconfig|--omit|--include)$/)
      if (sub === "add") return "named"
      if (/^(?:ci|clean-install|install-clean|ic|install-ci-test|cit|it|install-test)$/.test(sub)) return "manifest"
      return null
    case "pnpm":
      if (sub === "add") return "named"
      if (sub === "install" || sub === "i") return namedOr("manifest", /^(?:--filter|-F|-C|--dir)$/)
      return null
    case "yarn":
      if (sub === "add" || (sub === "global" && rest[0] === "add")) return "named"
      if (sub === "" || sub === "install") return "manifest"
      return null
    case "bun":
      if (sub === "add" || sub === "a") return "named"
      if (sub === "install" || sub === "i") return namedOr("manifest", /^(?:--cwd)$/)
      return null
    case "deno":
      if (sub === "add") return "named"
      if (sub === "install" || sub === "i") return namedOr("manifest", /^(?:--root|-n|--name|-c|--config)$/)
      return null
    case "pip": case "pip3": {
      if (sub !== "install") return null
      const ops = operands(/^(?:-r|--requirement|-c|--constraint|-e|--editable|-i|--index-url|--extra-index-url|-f|--find-links|-t|--target|--prefix|--root|--python-version|--platform|--src|--cache-dir|--log)$/)
      return ops.some((o) => !/^[./~]/.test(o)) ? "named" : "manifest"
    }
    case "pipx": return /^(?:install|inject|runpip)$/.test(sub) ? "named" : null
    case "uv":
      if (sub === "add" || (sub === "tool" && rest[0] === "install")) return "named"
      if (sub === "sync") return "manifest"
      return null
    case "poetry": return sub === "add" ? "named" : sub === "install" ? "manifest" : null
    case "pipenv": return sub === "install" ? namedOr("manifest") : null
    case "conda": case "mamba": case "micromamba": return /^(?:install|create)$/.test(sub) ? "named" : null
    case "cargo": return /^(?:add|install)$/.test(sub) ? "named" : null
    case "go": return /^(?:get|install)$/.test(sub) ? "named" : null
    case "gem": return sub === "install" ? "named" : null
    case "bundle": case "bundler": return sub === "add" ? "named" : sub === "install" ? "manifest" : null
    case "composer": return sub === "require" ? "named" : sub === "install" ? "manifest" : null
    case "apt": case "apt-get": case "aptitude": return sub === "install" || sub === "reinstall" ? "named" : null
    case "apk": return sub === "add" ? "named" : null
    case "dnf": case "yum": case "zypper": case "microdnf": case "tdnf": return /^(?:install|in|reinstall)$/.test(sub) ? "named" : null
    case "pacman": case "yay": case "paru": return /^-S(?![si]\b)[A-Za-z]*$/.test(sub) && rest.length ? "named" : null
    case "brew": return /^(?:install|reinstall)$/.test(sub) ? "named" : sub === "bundle" && (rest[0] ?? "install") === "install" ? "manifest" : null
    case "port": case "snap": case "flatpak": case "choco": case "scoop": case "winget": return sub === "install" ? "named" : null
    case "pkg": return sub === "install" || sub === "add" ? "named" : null
    case "nix-env": return /^(?:-i|--install|-iA)$/.test(sub) ? "named" : null
    case "nix": return sub === "profile" && rest[0] === "install" ? "named" : null
    default: return null
  }
}

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
  const addTest = (id, label, phrase, test) => { if (!rules.has(id)) rules.set(id, { id, label, phrase: phrase.slice(0, 160), test }) }
  // every negation in a sentence is read on its own: "don't forget to test,
  // and do not push" forbids the push and nothing else
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) for (const neg of sentence.matchAll(NEGATION_ALL)) {
    // only what follows the negation, within the same clause
    const after = sentence.slice(neg.index).split(/,\s*(?:but|and then|then|so)\b|\bbut\b/i)[0]
    // "don't forget to push" asks for the push
    if (SOFT_NEGATION.test(after)) continue
    if (/\bpush(?:es|ing|ed)?\b(?!\s+notifications?)/i.test(after)) add("push", "push to a remote", sentence, /^git\s+(?:-C\s+\S+\s+)?push\b/)
    if (/\bcommit(?:s|ting|ted)?\b/i.test(after) && !/\b(?:secrets?|credentials?|keys?|tokens?|passwords?|node_modules|binar\w*|large files?|generated)\b|\.env\b/i.test(after)) add("commit", "commit", sentence, /^git\s+(?:-C\s+\S+\s+)?commit\b/)
    if (/\bpublish(?:es|ing|ed)?\b/i.test(after)) add("publish", "publish a package", sentence, /^(?:(?:npm|yarn|pnpm|bun)\s+publish\b|cargo\s+publish\b|twine\s+upload\b|poetry\s+publish\b|gem\s+push\b)/)
    // "don't add (new) dependencies" / "do not install new packages": a
    // package the command NAMES (npm i x, pip install -U x, apt-get install x,
    // brew install x …). A plain "do not install dependencies/packages" also
    // covers installing what is already declared (npm install, npm ci, pip
    // install -r …) — that installs dependencies too.
    const dep = /\b(add|install)(?:s|ing|ed)?\b([^.;]{0,40}?)\b(?:dependenc|packages?|librar|deps\b|modules?\b)/i.exec(after)
    if (dep) {
      const onlyNew = /^add$/i.test(dep[1]) || /\b(?:new|additional|extra|more|another|other|third[- ]party)\b/i.test(dep[2])
      if (onlyNew) addTest("dependencies", "add a dependency", sentence, (cmd) => anySeg(cmd, PKG_ADD) || segmentsOf(cmd).some((s) => installKind(s) === "named"))
      else addTest("dependencies", "install dependencies", sentence, (cmd) => anySeg(cmd, PKG_ADD) || segmentsOf(cmd).some((s) => installKind(s) !== null))
    }
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

/** The fingerprint watchProhibited keeps, of a string's UTF-8 bytes (what
 *  write_file would write) — so a write can be recognised as a restore. */
export function contentFingerprint(content) {
  try { return crypto.createHash('sha256').update(String(content ?? ""), "utf8").digest('hex') } catch { return null }
}

/**
 * V7 — watch the files the objective forbids changing: fingerprint them as the
 * run finds them; `changed()` names those that now differ (content, creation
 * or deletion). A run that touched a file and put it back is not in breach.
 */
export function watchProhibited(objective = "", cwd = process.cwd(), { baseline = null } = {}) {
  const hash = (abs) => { try { return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') } catch { return null } }
  // `baseline` ({ rel: sha256|null }) is a fingerprint taken earlier — when a
  // task resumes, the state the TASK started from, not what a crashed run left
  const known = baseline && typeof baseline === "object" ? baseline : null
  const targets = prohibitedTargets(objective).map((rel) => {
    const abs = path.resolve(cwd, rel)
    const before = known && Object.prototype.hasOwnProperty.call(known, rel) ? known[rel] : hash(abs)
    return { rel, abs, before }
  })
  return {
    targets: targets.map((t) => t.rel),
    changed: () => targets.filter((t) => hash(t.abs) !== t.before).map((t) => t.rel),
    /** the fingerprints, to store with the task */
    baseline: () => Object.fromEntries(targets.map((t) => [t.rel, t.before])),
  }
}
