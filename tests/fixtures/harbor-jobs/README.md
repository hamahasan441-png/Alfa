# Harbor job fixtures (forge v149)

`tb2-real/`, `smoke/` and `single-task/` are trimmed copies of jobs written by **harbor 0.23.0**
running forge through `integrations/harbor` — `tb2-real` on three real
Terminal-Bench 2.0 tasks, `smoke` on `tests/harbor-tasks`, `single-task` on one task given with
`-p` (Harbor records it under `tasks`, not `datasets`) on an image with no Node — both driven by
`tests/tbench-stub-model.mjs` (so the Terminal-Bench rewards are 0 by
construction). Trimming kept the job `config.json`/`result.json` and, per trial,
only the `result.json` keys the reader uses.

`derived-mixed/` is `smoke/` plus three HAND-MADE trials for cases a stub run
cannot produce: an errored trial (no reward), a failed second attempt of a
passed task (pass@k), and a known cost on one trial only.

`timeout/` (v151) is a real job on a task with a 10-second agent timeout and a
stub model that never stops: Harbor cancelled the run, the adapter stopped
forge in the container, and forge's final ABORTED record (10 steps, its
tokens) is what Harbor reported. Its task path pointed at a scratch copy of
`forge-smoke-pass`; the traceback is trimmed.
