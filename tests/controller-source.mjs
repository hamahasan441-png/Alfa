/**
 * The controller's source text, for wiring tests.
 *
 * Forty suites prove that the controller is WIRED to something by searching
 * its source ("meta emits PLAN_COMPOSE", "ensureKnowledgeGraph at cwd"). The
 * controller is being split out of meta.js one phase at a time (Phase 2 of
 * the upgrade plan); every move used to mean editing each suite that greps
 * the moved code. They read it here instead, so a move adds one line below.
 *
 * Order is meta.js first, then its phases in the order runMeta calls them.
 * Tests not shipped (tests/ is excluded from the package).
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** The files that together make up the task controller. */
export const CONTROLLER_FILES = Object.freeze([
  "meta.js", //       runMeta: setup and the segment loop
  "metaplan.js", //   planPhase: restore, plan, validate, critique
  "metarepair.js", // repairSegment, requestVerification, buildContextBlock
  "metacomplete.js", // makeCompletion: attemptCompletion, refuseCompletion
  "metafinal.js", //  finalizePhase: fuse, terminal state, result
])

/** All controller files concatenated, newline-separated. */
export function controllerSource() {
  return CONTROLLER_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n")
}
