#!/usr/bin/env node
/**
 * forge — one-command test runner (`npm test` from forge/, or `node tests/run-all.mjs`).
 *
 * Before v20.2 there was no `npm test`: a contributor had to remember to start
 * mock-llm.mjs by hand and then invoke five suites individually. This runner is
 * the single source of truth for "is the build green?": it runs every suite as
 * a child process, judges each by its EXIT CODE (all five already exit non-zero
 * on failure), and returns non-zero if any suite fails.
 *
 * The two bash suites (e2e, cleanroom) each start and stop their own mock
 * provider, so this runner starts nothing itself and simply sequences them.
 *
 * Env switches (all opt-out, default = run everything):
 *   FORGE_TEST_CONCURRENCY=N node suites run N-at-a-time (default 4; 1 = old
 *                           sequential behavior; bash suites always sequential)
 *   FORGE_SKIP_E2E=1        skip the ~6.5-min e2e suite
 *   FORGE_SKIP_CLEANROOM=1  skip the clean-room npm-install suite
 *   FORGE_FAST=1            fast lane: node suites only (skips both bash suites)
 *
 * Zero dependencies — stdlib only.
 */
import { spawn } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

const fast = process.env.FORGE_FAST === "1"
const skipE2e = fast || process.env.FORGE_SKIP_E2E === "1"
const skipCleanroom = fast || process.env.FORGE_SKIP_CLEANROOM === "1"

// [label, command, args]. Node suites first (fast, self-contained), then the
// slower bash suites (each manages its own mock-llm on 127.0.0.1:8787).
const suites = [
  ["v131", "node", ["test-v131.mjs"]],
  ["v132", "node", ["test-v132.mjs"]],
  ["v133", "node", ["test-v133.mjs"]],
  ["v134", "node", ["test-v134.mjs"]],
  ["v135", "node", ["test-v135.mjs"]],
  ["v136", "node", ["test-v136.mjs"]],
  ["v137", "node", ["test-v137.mjs"]],
  ["v138", "node", ["test-v138.mjs"]],
  ["v139", "node", ["test-v139.mjs"]],
  ["v140", "node", ["test-v140.mjs"]],
  ["v1222-evidence-goal", "node", ["test-v1222-evidence-goal.mjs"]],
  ["v1222-cognition", "node", ["test-v1222-cognition-integration.mjs"]],
  ["alpha-core", "node", ["test-alpha-core.mjs"]],
  ["alpha-benchmark", "node", ["test-alpha-benchmark.mjs"]],
  ["supervisor", "node", ["test-supervisor.mjs"]],
  ["intelligence-benchmark", "node", ["test-intelligence-benchmark.mjs"]],
  ["agent-benchmark", "node", ["test-agent-benchmark.mjs"]],
  ["intelligence-expansion", "node", ["test-intelligence-expansion.mjs"]],
  ["autonomy-level2", "node", ["test-autonomy-level2.mjs"]],
  ["intelligence-next", "node", ["test-intelligence-next.mjs"]],
  ["intelligence-next-integration", "node", ["test-intelligence-next-integration.mjs"]],
  ["horizon-intelligence", "node", ["test-horizon-intelligence.mjs"]],
  ["horizon-risk", "node", ["test-horizon-risk.mjs"]],
  ["horizon-risk-integration", "node", ["test-horizon-risk-integration.mjs"]],
  ["horizon-impact", "node", ["test-horizon-impact.mjs"]],
  ["horizon-replan-integration", "node", ["test-horizon-replan-integration.mjs"]],
  ["horizon-cognition-integration", "node", ["test-horizon-cognition-integration.mjs"]],
  ["horizon-live-wiring", "node", ["test-horizon-live-wiring.mjs"]],
  ["horizon-integration-audit", "node", ["test-horizon-integration-audit.mjs"]],
  ["horizon-agent-live-integration", "node", ["test-horizon-agent-live-integration.mjs"]],
  ["horizon-recovery", "node", ["test-horizon-recovery.mjs"]],
  ["horizon-recovery-integration", "node", ["test-horizon-recovery-integration.mjs"]],
  ["horizon-coordinator", "node", ["test-horizon-coordinator.mjs"]],
  ["horizon-coordinator-integration", "node", ["test-horizon-coordinator-integration.mjs"]],
  ["intelligence-advanced", "node", ["test-intelligence-advanced.mjs"]],
  ["processguard", "node", ["test-processguard.mjs"]],
  ["security", "node", ["test-security.mjs"]],
  ["security-mode", "node", ["test-security-mode.mjs"]],
  ["capabilities", "node", ["test-capabilities.mjs"]],
  ["router", "node", ["test-router.mjs"]],
  ["toolintel", "node", ["test-toolintel.mjs"]],
  ["providers", "node", ["test-providers.mjs"]],
  ["diffpatch", "node", ["test-diffpatch.mjs"]],
  ["memory", "node", ["test-memory.mjs"]],
  ["failover", "node", ["test-failover.mjs"]],
  ["compaction", "node", ["test-context-compaction.mjs"]],
  ["chat-compact", "node", ["test-chat-compaction.mjs"]],
  ["parser-fuzz", "node", ["test-parser-fuzz.mjs"]],
  ["state-writes", "node", ["test-state-writes.mjs"]],
  ["state-concurrency", "node", ["test-state-concurrency.mjs"]],
  ["cp-crash", "node", ["test-checkpoint-crash-matrix.mjs"]],
  ["mem-pipeline", "node", ["test-memory-pipeline.mjs"]],
  ["chat", "node", ["test-chat.mjs"]],
  ["walk", "node", ["test-walk.mjs"]],
  ["plans", "node", ["test-plans.mjs"]],
  ["checkpoint", "node", ["test-checkpoint.mjs"]],
  ["repomap", "node", ["test-repomap.mjs"]],
  ["plugins", "node", ["test-plugins.mjs"]],
  ["mcp", "node", ["test-mcp.mjs"]],
  ["mcp-catalog", "node", ["test-mcpcatalog-top100.mjs"]],
  ["lsp", "node", ["test-lsp.mjs"]],
  ["retrieval", "node", ["test-retrieval.mjs"]],
  ["semantic", "node", ["test-semantic.mjs"]],
  ["sessions", "node", ["test-sessions.mjs"]],
  ["skills", "node", ["test-skills.mjs"]],
  ["json", "node", ["test-json.mjs"]],
  ["install", "node", ["test-install.mjs"]],
  ["config", "node", ["test-config.mjs"]],
  ["package", "node", ["test-package.mjs"]],
  ["effort", "node", ["test-effort.mjs"]],
  ["ui", "node", ["test-ui.mjs"]],
  ["autonomy", "node", ["test-autonomy.mjs"]],
  ["chaos", "node", ["test-chaos.mjs"]],
  // ---- P0/P1 audit regression suites (v24 hardening) -------------------
  ["dag-done", "node", ["test-whole-dag-completion.mjs"]],
  ["node-gate", "node", ["test-node-verification-gate.mjs"]],
  ["final-risk", "node", ["test-final-risk-recalculation.mjs"]],
  ["verif-ro", "node", ["test-verifier-readonly.mjs"]],
  ["worker-to", "node", ["test-worker-timeout-cleanup.mjs"]],
  ["node-id", "node", ["test-exact-node-attribution.mjs"]],
  ["conflicts", "node", ["test-dag-conflicts.mjs"]],
  ["readonly", "node", ["test-readonly-state.mjs"]],
  ["bad-plan", "node", ["test-invalid-plan.mjs"]],
  ["continuation", "node", ["test-max-segment-continuation.mjs"]],
  ["verif-scope", "node", ["test-verification-scope.mjs"]],
  ["verif-stale", "node", ["test-verification-staleness.mjs"]],
  ["exit-code", "node", ["test-unknown-exit-code.mjs"]],
  ["cp-integrity", "node", ["test-checkpoint-integrity.mjs"]],
  ["cp-restore", "node", ["test-checkpoint-restore.mjs"]],
  ["crash-resume", "node", ["test-crash-resume.mjs"]],
  ["effects", "node", ["test-effect-reconciliation.mjs"]],
  ["git-recov", "node", ["test-git-recovery.mjs"]],
  ["routing", "node", ["test-model-routing-history.mjs"]],
  ["mcp-life", "node", ["test-mcp-lifecycle.mjs"]],
  ["mcp-dual-era", "node", ["test-mcp-dual-era.mjs"]],
  ["run-teaches", "node", ["test-run-teaches.mjs"]],
  ["single-file", "node", ["test-single-file.mjs"]],
  ["osc", "node", ["test-osc.mjs"]],
  ["disciplines", "node", ["test-disciplines.mjs"]],
  ["prompt-budget", "node", ["test-prompt-budget.mjs"]],
  ["cache-positions", "node", ["test-cache-positions.mjs"]],
  ["skill-registry", "node", ["test-skill-registry.mjs"]],
  ["perf-calibration", "node", ["test-perf-calibration.mjs"]],
  ["openai-cache", "node", ["test-openai-cache.mjs"]],
  ["run-mcp-config", "node", ["test-run-mcp-config.mjs"]],
  ["lessons-stale", "node", ["test-lessons-stale.mjs"]],
  ["command-repair", "node", ["test-command-repair.mjs"]],
  ["lesson-outcome", "node", ["test-lesson-outcome.mjs"]],
  ["lesson-when-proven", "node", ["test-lesson-when-proven.mjs"]],
  ["memory-rules", "node", ["test-memory-rules.mjs"]],
  ["task-rules", "node", ["test-task-rules.mjs"]],
  ["rules-survive", "node", ["test-rules-survive.mjs"]],
  ["yolo-no-refusal", "node", ["test-yolo-no-refusal.mjs"]],
  ["mcp-legacy-sse", "node", ["test-mcp-legacy-sse.mjs"]],
  ["afford", "node", ["test-afford.mjs"]],
  ["plan-chat", "node", ["test-plan-chat.mjs"]],
  ["out-of-credits", "node", ["test-out-of-credits.mjs"]],
  ["retry-resumes", "node", ["test-retry-resumes.mjs"]],
  ["rate-limits", "node", ["test-rate-limits.mjs"]],
  ["check-identity", "node", ["test-check-identity.mjs"]],
  ["rate-limit-memory", "node", ["test-rate-limit-memory.mjs"]],
  ["provider-honesty", "node", ["test-provider-honesty.mjs"]],
  ["silent-bugs", "node", ["test-silent-bugs.mjs"]],
  ["audit2", "node", ["test-audit2.mjs"]],
  ["retry-after-restart", "node", ["test-retry-after-restart.mjs"]],
  ["prune-state", "node", ["test-prune-state.mjs"]],
  ["retry-word", "node", ["test-retry-word.mjs"]],
  ["dropped-stream", "node", ["test-dropped-stream.mjs"]],
  ["provider-failures", "node", ["test-provider-failures.mjs"]],
  ["plan-go-restart", "node", ["test-plan-go-restart.mjs"]],
  ["boot", "node", ["test-boot.mjs"]],
  ["provider-errors-shown", "node", ["test-provider-errors-shown.mjs"]],
  ["result-checks", "node", ["test-result-checks.mjs"]],
  ["rate-limit-raised", "node", ["test-rate-limit-raised.mjs"]],
  ["plan-questions", "node", ["test-plan-questions.mjs"]],
  ["free-suggestion", "node", ["test-free-suggestion.mjs"]],
  ["repl-complete", "node", ["test-repl-complete.mjs"]],
  ["yolo-secrets", "node", ["test-yolo-secrets.mjs"]],
  ["model-ids", "node", ["test-model-ids.mjs"]],
  ["memory-scope", "node", ["test-memory-scope.mjs"]],
  ["free-tools", "node", ["test-free-tools.mjs"]],
  ["piped-grep", "node", ["test-piped-grep.mjs"]],
  ["piped-chain", "node", ["test-piped-chain.mjs"]],
  ["check-status", "node", ["test-check-status.mjs"]],
  ["failed-check-card", "node", ["test-failed-check-card.mjs"]],
  ["head-closes", "node", ["test-head-closes.mjs"]],
  ["prompt-engineering", "node", ["test-prompt-engineering.mjs"]],
  ["model-cache-age", "node", ["test-model-cache-age.mjs"]],
  ["plan-checklist", "node", ["test-plan-checklist.mjs"]],
  ["lesson-credit", "node", ["test-lesson-credit.mjs"]],
  ["ui-polish", "node", ["test-ui-polish.mjs"]],
  ["tbench-headless", "node", ["test-tbench-headless.mjs"]],
  ["tbench-report", "node", ["test-tbench-report.mjs"]],
  ["wiring", "node", ["test-wiring.mjs"]],
  ["ask", "node", ["test-ask.mjs"]],
  ["mcp-elicit", "node", ["test-mcp-elicitation.mjs"]],
  ["mcp-http-stream", "node", ["test-mcp-http-stream.mjs"]],
  ["mcp-reconnect", "node", ["test-mcp-reconnect.mjs"]],
  ["mcp-session-end", "node", ["test-mcp-session-end.mjs"]],
  ["openurl", "node", ["test-openurl.mjs"]],
  ["lsp-life", "node", ["test-lsp-lifecycle.mjs"]],
  ["leaks", "node", ["test-resource-leaks.mjs"]],
  ["version", "node", ["test-version-consistency.mjs"]],
  ["lessons", "node", ["test-lessons-schema.mjs"]],
  ["lesson-tiers", "node", ["test-lesson-tiers.mjs"]],
  ["hygiene", "node", ["test-path-hygiene.mjs"]],
  // ---- v21.1 security audit: adversarial P0 suites ----------------------
  ["ssrf-pin", "node", ["test-ssrf-pinning.mjs"]],
  ["fs-toctou", "node", ["test-fs-toctou.mjs"]],
  ["read-toctou", "node", ["test-read-toctou.mjs"]],
  ["grep-redos", "node", ["test-grep-redos.mjs"]],
  ["tool-fuzz-contract", "node", ["test-tool-fuzz-contract.mjs"]],
  ["shell-substitution", "node", ["test-shell-substitution.mjs"]],
  ["context-fit", "node", ["test-context-fit.mjs"]],
  ["prompt-policy", "node", ["test-prompt-policy.mjs"]],
  ["harness-abort", "node", ["test-harness-abort.mjs"]],
  ["loop-budget", "node", ["test-loop-budget.mjs"]],
  ["governor-answer", "node", ["test-governor-answer.mjs"]],
  ["graph-integrity", "node", ["test-graph-integrity.mjs"]],
  ["evidence-provenance", "node", ["test-evidence-provenance.mjs"]],
  ["benchsuite", "node", ["test-benchsuite.mjs"]],
  ["tool-result-history", "node", ["test-tool-result-history.mjs"]],
  ["autofix-shape", "node", ["test-autofix-shape.mjs"]],
  ["review-lines", "node", ["test-review-lines.mjs"]],
  ["plugin-iso", "node", ["test-plugin-isolation.mjs"]],
  ["hardening", "node", ["test-hardening-v21.mjs"]],
  ["v21-2", "node", ["test-v21-2.mjs"]],
  ["omega", "node", ["test-omega.mjs"]],
  ["infinity", "node", ["test-infinity.mjs"]],
  ["v25", "node", ["test-v25.mjs"]],
  ["v26", "node", ["test-v26.mjs"]],
  ["v27", "node", ["test-v27.mjs"]],
  ["v28", "node", ["test-v28.mjs"]],
  ["v29", "node", ["test-v29.mjs"]],
  ["v30", "node", ["test-v30.mjs"]],
  ["v31", "node", ["test-v31.mjs"]],
  ["v32", "node", ["test-v32.mjs"]],
  ["v33", "node", ["test-v33.mjs"]],
  ["v34", "node", ["test-v34.mjs"]],
  ["v35", "node", ["test-v35.mjs"]],
  ["v36", "node", ["test-v36.mjs"]],
  ["v37", "node", ["test-v37.mjs"]],
  ["v38", "node", ["test-v38.mjs"]],
  ["v39", "node", ["test-v39.mjs"]],
  ["v40", "node", ["test-v40.mjs"]],
  ["v41", "node", ["test-v41.mjs"]],
  ["v42", "node", ["test-v42.mjs"]],
  ["v43", "node", ["test-v43.mjs"]],
  ["v44", "node", ["test-v44.mjs"]],
  ["v45", "node", ["test-v45.mjs"]],
  ["v46", "node", ["test-v46.mjs"]],
  ["v47", "node", ["test-v47.mjs"]],
  ["v48", "node", ["test-v48.mjs"]],
  ["v49", "node", ["test-v49.mjs"]],
  ["v50", "node", ["test-v50.mjs"]],
  ["v51", "node", ["test-v51.mjs"]],
  ["v52", "node", ["test-v52.mjs"]],
  ["v53", "node", ["test-v53.mjs"]],
  ["v54", "node", ["test-v54.mjs"]],
  ["v55", "node", ["test-v55.mjs"]],
  ["v56", "node", ["test-v56.mjs"]],
  ["v57", "node", ["test-v57.mjs"]],
  ["v58", "node", ["test-v58.mjs"]],
  ["v59", "node", ["test-v59.mjs"]],
  ["v60", "node", ["test-v60.mjs"]],
  ["v61", "node", ["test-v61.mjs"]],
  ["v62", "node", ["test-v62.mjs"]],
  ["v63", "node", ["test-v63.mjs"]],
  ["v64", "node", ["test-v64.mjs"]],
  ["v65", "node", ["test-v65.mjs"]],
  ["v66", "node", ["test-v66.mjs"]],
  ["v67", "node", ["test-v67.mjs"]],
  ["v68", "node", ["test-v68.mjs"]],
  ["v69", "node", ["test-v69.mjs"]],
  ["v70", "node", ["test-v70.mjs"]],
  ["v71", "node", ["test-v71.mjs"]],
  ["v72", "node", ["test-v72.mjs"]],
  ["v73", "node", ["test-v73.mjs"]],
  ["v74", "node", ["test-v74.mjs"]],
  ["v75", "node", ["test-v75.mjs"]],
  ["v76", "node", ["test-v76.mjs"]],
  ["v77", "node", ["test-v77.mjs"]],
  ["v78", "node", ["test-v78.mjs"]],
  ["v79", "node", ["test-v79.mjs"]],
  ["v80", "node", ["test-v80.mjs"]],
  ["v81", "node", ["test-v81.mjs"]],
  ["v82", "node", ["test-v82.mjs"]],
  ["v83", "node", ["test-v83.mjs"]],
  ["v84", "node", ["test-v84.mjs"]],
  ["v85", "node", ["test-v85.mjs"]],
  ["v86", "node", ["test-v86.mjs"]],
  ["v87", "node", ["test-v87.mjs"]],
  ["v88", "node", ["test-v88.mjs"]],
  ["v89", "node", ["test-v89.mjs"]],
  ["v90", "node", ["test-v90.mjs"]],
  ["v91", "node", ["test-v91.mjs"]],
  ["v91-core", "node", ["test-v91-core.mjs"]],
  ["v92", "node", ["test-v92.mjs"]],
  ["v92-core", "node", ["test-v92-core.mjs"]],
  ["v93", "node", ["test-v93.mjs"]],
  ["v93g", "node", ["test-v93g.mjs"]],
  ["v93r", "node", ["test-v93r.mjs"]],
  ["v93w", "node", ["test-v93w.mjs"]],
  ["v93b", "node", ["test-v93b.mjs"]],
  ["v93l", "node", ["test-v93l.mjs"]],
  ["v93t", "node", ["test-v93t.mjs"]],
  ["v93st", "node", ["test-v93st.mjs"]],
  ["v94a", "node", ["test-v94a.mjs"]],
  ["v93s", "node", ["test-v93s.mjs"]],
  // ---- v94 masterwise: Engineering Intelligence Core acceptance suites ---
  ["search-providers", "node", ["test-search-providers.mjs"]],
  ["exec-controller", "node", ["test-execution-controller.mjs"]],
  ["eng-memory", "node", ["test-engmemory.mjs"]],
  ["plannerisk", "node", ["test-plannerisk.mjs"]],
  // ---- v94b: TokenRouter provider + understand-anything skills pack -------
  ["v94b", "node", ["test-v94b.mjs"]],
  ["toolwise", "node", ["test-toolwise.mjs"]],
  // ---- v94 skillwise: obra/superpowers engineering-process pack -----------
  ["skillwise", "node", ["test-skillwise.mjs"]],
  // ---- v94 knowwise: auto KG floor graph + blast-radius + Termux shell ----
  ["knowwise", "node", ["test-knowwise.mjs"]],
  // ---- v94 deepwise: plan competition + adoption, pre-mutation critique ----
  ["deepwise", "node", ["test-deepwise.mjs"]],
  // ---- v94 fastwise: freshness caches + likely-next prefetch + dedup audit -
  ["fastwise", "node", ["test-fastwise.mjs"]],
  // ---- v94 todowise: the TODO.md open-gap ledger, closed with proof ----
  ["todowise", "node", ["test-todowise.mjs"]],
  // ---- v95 worktreewise: isolated worktree execution for DAG nodes --------
  ["worktreewise", "node", ["test-worktreewise.mjs"]],
  // ---- v96 unifywise: every disconnected wire reconnected and pinned ------
  ["unifywise", "node", ["test-unifywise.mjs"]],
  ["envfingerprint", "node", ["test-envfingerprint.mjs"]],
  // ---- v97 unifiedwise: one coherent engineering intelligence ----
  ["sourceresolve", "node", ["test-sourceresolve.mjs"]],
  ["v97", "node", ["test-v97.mjs"]],
  // ---- v98 shipwise: structured extraction wired + verified git delivery ----
  ["gitship", "node", ["test-gitship.mjs"]],
  ["v98", "node", ["test-v98.mjs"]],
  ["v99", "node", ["test-v99.mjs"]],
  // ---- v100 fabricwise: capability fabric groundwork (MCP annotations + parallel connect)
  ["v100", "node", ["test-v100.mjs"]],
  // ---- v101 P0 "the instrument": phase tracing (where the wall-clock went) --
  ["v101", "node", ["test-v101.mjs"]],
  // ---- v102 reviewwise: the adversarial review reaches agent.js ------------
  ["v102", "node", ["test-v102.mjs"]],
  // ---- v103 taskintel: workspace identity + requirement evolution ---------
  ["v103", "node", ["test-v103.mjs"]],
  // ---- v104 boundwise: the workspace boundary enforced in code -----------
  ["v104", "node", ["test-v104.mjs"]],
  // ---- v105 selfaudit: capability that exists but nothing calls -----------
  ["v105", "node", ["test-v105.mjs"]],
  // ---- v106 resumewise: a resumed task hears the new instruction ----------
  ["v106", "node", ["test-v106.mjs"]],
  // ---- v107 carrywise: the launch line is not always the task -------------
  ["v107", "node", ["test-v107.mjs"]],
  // ---- v108 rootwise: memory survives `cd`; an answer knows its question --
  ["v108", "node", ["test-v108.mjs"]],
  // ---- v114 measurewise: the learning claims become falsifiable ----------
  ["v114", "node", ["test-v114.mjs"]],
  // ---- v115 honestwise: loops halt, refused runs are not COMPLETED, a -----
  // ---- cancel is CANCELLED at the node level ------------------------------
  ["v115", "node", ["test-v115.mjs"]],
  // ---- v116 measurewise-2: forge measures itself, and stops re-writing -----
  // ---- an index that never changed ---------------------------------------
  ["v116", "node", ["test-v116.mjs"]],
  // ---- v117 searchwise: search knows what kind of question it is, and -----
  // ---- learns which tool actually reached the answer ----------------------
  ["v117", "node", ["test-v117.mjs"]],
  // ---- v118 completionwise: a governor STOP is a candidate, not a verdict --
  ["v118", "node", ["test-v118.mjs"]],
  // ---- v119 calibratewise: the completion gate learns how many attempts a --
  // ---- blocker deserves, and cannot learn its way into a false completion --
  ["v119", "node", ["test-v119.mjs"]],
  // ---- v120 honestcheck: a grep is not a test, "do not implement" is not ---
  // ---- an instruction to implement ----------------------------------------
  ["v120", "node", ["test-v120.mjs"]],
  // ---- v121 deadwire: measured prediction error reaches the risk number, ---
  // ---- a task class is not a strategy, a learning key must identify what --
  // ---- was learned --------------------------------------------------------
  ["v121", "node", ["test-v121.mjs"]],
  // ---- v122 yolowise: ONE full-control switch, honoured by every layer ------
  // ---- that can refuse, pause or freeze ------------------------------------
  ["v122", "node", ["test-v122.mjs"]],
  // ---- v123 hardereval: the eval set could only measure one model call, ----
  // ---- so the A/B it fed could only ever report "no difference" ------------
  ["v123", "node", ["test-v123.mjs"]],
  // ---- v124 yolodiag: forge already ships unlimited, and one stale config --
  // ---- key silently put every layer back in charge without saying which ----
  ["v124", "node", ["test-v124.mjs"]],
  // ---- v125 memoryworth: engineering memory was the one retrieval surface --
  // ---- with no outcome loop — nine ranking priors and not one measurement --
  ["v125", "node", ["test-v125.mjs"]],
  // ---- v126 shapewise: the planner adopted the SAME plan shape 32/32 and ----
  // ---- never learned whether it was the one that worked -------------------
  ["v126", "node", ["test-v126.mjs"]],
  // ---- v127 costwise: the A/B called "no measurable difference" on tied ----
  // ---- outcomes without ever reading the cost it had just printed ---------
  ["v127", "node", ["test-v127.mjs"]],
  // ---- v128 auditwise: a 30s connect guard that no config could change, ----
  // ---- and a test that passed with the defect put back --------------------
  ["v128", "node", ["test-v128.mjs"]],
  // ---- v129 dupewise: 21 duplicated export names — RISK_ORDER was two -----
  // ---- incompatible TYPES, RETIRE_BELOW two values, pidAlive copy-pasted --
  ["v129", "node", ["test-v129.mjs"]],
  ["v130", "node", ["test-v130.mjs"]],
  ["alpha-kernel", "node", ["test-alpha-kernel.mjs"]],
  ["v3-preservation", "node", ["test-v3-preservation.mjs"]],
  ["v3-persistence", "node", ["test-v3-persistence.mjs"]],
  ["cognition", "node", ["test-cognition.mjs"]],
  ["outcome-close", "node", ["test-outcome-close.mjs"]],
  ["authority", "node", ["test-authority.mjs"]],
  ["intel", "node", ["test-intel.mjs"]],
  ["learn", "node", ["test-learn.mjs"]],
  ["bind", "node", ["test-bind.mjs"]],
  ["route", "node", ["test-route.mjs"]],
  ["caplearn", "node", ["test-caplearn.mjs"]],
  ["create", "node", ["test-create.mjs"]],
  ["perform", "node", ["test-perform.mjs"]],
  ["meta", "node", ["test-meta.mjs"]],
  ["modelwise", "node", ["test-modelwise.mjs"]],
  ["joint", "node", ["test-joint.mjs"]],
  ["critic", "node", ["test-critic.mjs"]],
  ["github", "node", ["test-github.mjs"]],
  ["github-cli", "node", ["test-github-cli.mjs"]],
  ["yolo-unlimited", "node", ["test-yolo-unlimited.mjs"]],
]
if (!skipE2e) suites.push(["e2e", "bash", ["e2e-forge.sh"]])
if (!skipCleanroom) suites.push(["cleanroom", "bash", ["cleanroom-v20.sh"]])
if (!skipCleanroom) suites.push(["cleanroom-pkg", "node", ["test-clean-room-package.mjs"]])

// Development/test security mode intentionally disables enforcement-heavy
// adapters. Their assertions belong to the production-security lane below;
// running them here would turn expected OFF-mode behavior into false failures.
const enforcementSuites = new Set(["security", "memory", "mem-pipeline", "plugins", "toolintel"])
if (process.env.FORGE_SECURITY_MODE === "off") {
  for (let i = suites.length - 1; i >= 0; i--) {
    if (enforcementSuites.has(suites[i][0])) suites.splice(i, 1)
  }
}

/** Escape a string for a GitHub Actions workflow command (::error::). */
function wfEscape(s) {
  return String(s ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
}

/**
 * Emit a GitHub annotation for a failing suite.
 *
 * CI logs are not always reachable from a workstation, but annotations are
 * exposed through the Checks API — so a red build can be diagnosed without
 * downloading the job log.
 */
function annotate(label, output, limit = 2400) {
  const lines = String(output ?? "").split("\n")
  const interesting = lines.filter((l) => /FAIL|Error|error:|AssertionError|✗|failed|not ok|Traceback/i.test(l))
  const body = (interesting.length ? interesting : lines.slice(-25)).slice(0, 25).join(" ⏎ ")
  console.log(`::error title=suite "${label}" failed::${wfEscape(body.slice(0, limit))}`)
}

function run([label, cmd, args]) {
  return new Promise((resolve) => {
    const target = path.join(here, args[0])
    if (!fs.existsSync(target)) {
      console.log(`\n\x1b[33m▷ ${label} — SKIPPED (${args[0]} not found)\x1b[0m`)
      return resolve({ label, ok: null, ms: 0, output: "" })
    }
    console.log(`\n\x1b[1m\x1b[36m▷ ${label}\x1b[0m  (${cmd} ${args.join(" ")})`)
    const t0 = Date.now()
    let buf = ""
    // v171: the isolation the comment below always claimed. Suites inherited
    // this process's environment, so every suite that did not set FORGE_HOME
    // itself read and wrote the REAL ~/.forge — health, rate limits, lessons,
    // sessions — and saw what other suites, running at the same time, left
    // there (a flaky out-of-credits failure, and 94MB of test state in one
    // home). Each suite now gets its own home, removed when it ends.
    const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), `forge-suite-${label.replace(/[^\w-]/g, "_")}-`))
    const child = spawn(cmd, args, {
      cwd: here,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORGE_HOME: suiteHome, FORGE_TEST_SUITE_HOME: suiteHome },
    })
    child.on("close", () => { try { fs.rmSync(suiteHome, { recursive: true, force: true }) } catch { /* best effort */ } })
    // A suite that leaks a handle can otherwise hold the whole runner open
    // forever. Bound each child so npm test reports a concrete failure instead
    // of becoming an apparent hang. The e2e/cleanroom suites are intentionally
    // given a longer budget because they are real integration runs.
    const timeoutMs = suiteTimeoutMs({ command: cmd })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      const signalGroup = (signal) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch {}
      }
      signalGroup("SIGTERM")
      setTimeout(() => signalGroup("SIGKILL"), 2000).unref()
    }, timeoutMs)
    timer.unref()
    // v89 perf: output is buffered and printed only when a suite FAILS (full
    // output + GitHub annotation) — with the parallel pool, live interleaved
    // forwarding from 4+ suites was unreadable. The summary table is unchanged.
    const collect = (chunk) => { buf += String(chunk) }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.on("error", (e) => {
      clearTimeout(timer)
      console.log(`\x1b[31m  cannot launch ${cmd}: ${e.message}\x1b[0m`)
      resolve({ label, ok: false, ms: Date.now() - t0, output: buf })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const ok = !timedOut && code === 0
      if (!ok) {
        if (timedOut) buf += `\nFORGE_TEST_TIMEOUT: ${timeoutMs}ms\n`
        process.stdout.write(buf)
        annotate(label, buf)
      }
      resolve({ label, ok, ms: Date.now() - t0, output: buf })
    })
  })
}

// v89 perf: the node suites run through a worker pool — they are independent
// (per-suite mkdtemp FORGE_HOME — set by run() since v171, ephemeral ports, no
// shared fixtures), so the old one-at-a-time loop just serialized ~85s of mostly-idle waits. The two
// bash suites share port 8787 and stay sequential at the end.
// FORGE_TEST_CONCURRENCY=1 restores the old sequential behavior exactly.
// v100: concurrency is derived from the MACHINE, not hardcoded. A flat 4 is
// fine on a laptop and fatal on a phone: each suite spawns its own children
// (mock providers, MCP/LSP stubs, PTYs, http servers), and Android's
// lowmemorykiller does not kill the greediest child — it kills the WHOLE
// Termux session, so forge dies with SIGKILL (signal 9) and the terminal has
// to be reopened. FORGE_TEST_CONCURRENCY still wins when set explicitly.
const { resourceProfile, memoryHeadroomOk, isAndroid } = await import("../profile.js")
const { testConcurrency, suiteTimeoutMs, shouldForceUnsafeConcurrency } = await import("../test-runner-policy.js")
const PROFILE = resourceProfile()
const UNSAFE = shouldForceUnsafeConcurrency()
const unsafeRequested = Number(process.env.FORGE_TEST_CONCURRENCY)
const CONCURRENCY = UNSAFE
  ? Math.max(1, Math.min(8, Number.isFinite(unsafeRequested) && unsafeRequested > 0 ? Math.floor(unsafeRequested) : 1))
  : testConcurrency({
      profile: PROFILE,
      requested: process.env.FORGE_TEST_CONCURRENCY,
      android: isAndroid(),
      perChildMB: 220,
    })
console.log(`\n\x1b[2mmachine: ${PROFILE.cores} core(s), ${PROFILE.freeMB}MB available, tier ${PROFILE.tier}${isAndroid() ? ", android/termux" : ""} → concurrency ${CONCURRENCY}${UNSAFE ? " (UNSAFE override)" : ""}\x1b[0m`)
const nodeSuites = suites.filter((s) => s[1] === "node")
const bashSuites = suites.filter((s) => s[1] !== "node")
const byLabel = new Map()
/** Wait (bounded) until there is room for another child. A long run under
 *  memory pressure should SLOW DOWN, not be killed halfway through. */
async function awaitHeadroom(label) {
  let waited = 0
  while (!memoryHeadroomOk({ perChildMB: 220, headroomMB: 700 }) && waited < 60000) {
    if (waited === 0) console.log(`\x1b[33m  ⏸ ${label}: waiting for memory headroom\x1b[0m`)
    await new Promise((r) => setTimeout(r, 1000))
    waited += 1000
  }
}

async function pool(jobs, n) {
  const queue = [...jobs.entries()]
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const [, job] = queue.shift()
      await awaitHeadroom(job[0])
      byLabel.set(job[0], await run(job))
    }
  }))
}
await pool(nodeSuites, CONCURRENCY)
for (const s of bashSuites) byLabel.set(s[0], await run(s))
const results = suites.map((s) => byLabel.get(s[0])).filter(Boolean)

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)
console.log("\n" + "─".repeat(48))
console.log("\x1b[1mtest summary\x1b[0m")
let failed = 0
for (const r of results) {
  const tag = r.ok === null ? "\x1b[33mSKIP\x1b[0m" : r.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"
  if (r.ok === false) failed++
  console.log(`  ${tag}  ${r.label.padEnd(11)} ${fmt(r.ms)}`)
}
console.log("─".repeat(48))
if (failed) {
  console.log(`\x1b[31m${failed} suite(s) failed\x1b[0m`)
  process.exit(1)
}
console.log(`\x1b[32mall ${results.filter((r) => r.ok).length} suite(s) passed\x1b[0m`)
