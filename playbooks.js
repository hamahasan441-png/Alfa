/**
 * forge — the first-party playbooks, with their steps (v165).
 *
 * The prompt has named these since v53 ("PLAYBOOKS: focused_verify, pr_notes
 * (follow steps, do not spawn plugin-host)"), and no steps existed anywhere:
 * a playbook was a name, a one-line description and some ranking tags. Next
 * to "SKILLS (call load_skill before using)", the model did the reasonable
 * thing and called `load_skill focused_verify` — reported from a real run —
 * and got "skill not found", a wasted step. load_skill now serves these, and
 * each step names a tool forge actually has.
 *
 * No imports: tools.js reads this on the agent's boot path.
 */

export const PLUGIN_PLAYBOOKS = [
  {
    name: "repo_map", description: "Walk the repo map and name the files that matter", readOnly: true, tags: ["map", "index", "symbols"],
    steps: [
      "Start from the repo map already in your prompt; if it is missing or thin, `list_dir` the root and `glob_files` the source patterns.",
      "Find the entry points (package.json bin/main, main.*, cmd/, src/index.*) and read their imports with `read_file`.",
      "Use `code_context` or `grep_files` on the symbols the task names to find where they are defined and used.",
      "Answer with a short list: each file that matters, one line on its role, and how they connect.",
    ],
  },
  {
    name: "focused_verify", description: "Run the stack-native test command on changed files", readOnly: true, tags: ["test", "verify", "cargo", "npm", "failing", "debug"],
    steps: [
      "List what changed: `git_status`, then `git_diff` (add the base branch when comparing a branch).",
      "Find the project's own test command: package.json scripts, Makefile, Cargo.toml, pyproject/pytest.ini, go.mod. Use it; do not invent one.",
      "Run only the tests that cover the changed files first (the test file next to the source, or a name filter such as `-t`, `-k`, `--run`), with `bash`.",
      "If those pass, run the full suite once. Read failures from the first error, not the last line.",
      "Report: the exact commands run, pass/fail counts, and each failure with its file:line.",
    ],
  },
  {
    name: "secret_scan", description: "Scan the diff for keys, tokens, and private URLs", readOnly: true, tags: ["secret", "security", "redact"],
    steps: [
      "Get the change set: `git_diff` (and the staged diff when there is one).",
      "`grep_files` the changed files for key shapes: `sk-`, `ghp_`, `xox`, `AKIA`, `-----BEGIN`, `api[_-]?key`, `secret`, `token`, `password`, and private hosts (10.*, 192.168.*, *.internal).",
      "Check that .env and credential files are listed in .gitignore and not staged.",
      "Report each hit with file:line and why it matters. Never print a full secret value — show the first 4 characters only.",
    ],
  },
  {
    name: "impact_trace", description: "Follow importers, tests, and deploy edges for a file", readOnly: true, tags: ["impact", "graph", "depend", "module"],
    steps: [
      "For the file in question, find who imports it: `kg_query` (\"what depends on <file>\") or `grep_files` for its module name.",
      "Find the tests that exercise it: test files that import it or name its exports.",
      "Check deploy and build edges: CI workflows, Dockerfiles, package.json files/exports that mention it.",
      "Report the blast radius: direct importers, tests to run, and anything shipped that includes it.",
    ],
  },
  {
    name: "patch_apply", description: "Apply one atomic unified diff and checkpoint", readOnly: false, tags: ["patch", "edit", "apply"],
    steps: [
      "Read every file the diff touches with `read_file`, so the context lines match what is on disk.",
      "Apply the whole diff in one `apply_patch` call — not piece by piece — so it lands or fails as a unit (forge checkpoints before writing).",
      "If it is rejected, re-read the file and fix the hunk's context; do not force it.",
      "Verify right after: run the project's test or build command, then show `git_diff` of what changed.",
    ],
  },
  {
    name: "pr_notes", description: "Draft a PR summary from the verify ledger", readOnly: true, tags: ["pr", "review", "summary"],
    steps: [
      "Collect the change: `git_log` since the base branch and `git_diff --stat`.",
      "Collect the evidence: the test/build commands this run executed and their results (only what actually ran).",
      "Draft: What (one paragraph), Changes (one bullet per behavioural change), Verified (commands and results), Open (what is not done).",
      "State only what the evidence shows: a check that was not run is listed as not run.",
    ],
  },
]

/** A first-party playbook by name, as load_skill serves it; null when none. */
export function playbookText(name) {
  const b = PLUGIN_PLAYBOOKS.find((p) => p.name === String(name ?? "").trim())
  if (!b) return null
  return [
    `# Playbook: ${b.name}`,
    "",
    b.description + (b.readOnly ? " (read-only)." : "."),
    "",
    "Follow these steps with forge's own tools — no plugin-host is needed:",
    ...b.steps.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n")
}
