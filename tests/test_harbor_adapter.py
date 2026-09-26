"""forge v149 — the Harbor adapter, in two halves.

CORE (forge_harbor/core.py — any python3, so it runs in forge's CI): the
provider table, the pinned Node and its hash check, the run command, the
result mapping. These decide what runs, with which key, on which verified
binary, so they are never skipped.

AGENT (forge_harbor/agent.py — needs harbor, Python >= 3.12): the
BaseInstalledAgent subclass, run against the real harbor base classes with
the container faked: every command and upload is recorded, so each test
asserts on what the adapter would actually do to a task environment. Skipped,
and SAID to be skipped, when harbor is not importable.

    PYTHONPATH=integrations/harbor python3 tests/test_harbor_adapter.py

Run by tests/test-tbench-report.mjs. The real thing — harbor + Docker + real
Terminal-Bench 2.0 images — was run while building this (CHANGELOG, v149).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import shlex
import sys
import tarfile
import tempfile
from pathlib import Path
from types import SimpleNamespace

import forge_harbor.core as C

try:
    import forge_harbor.agent as A
    HARBOR = True
except ImportError as e:  # harbor absent, or Python < 3.12
    A = None
    HARBOR = False
    HARBOR_WHY = str(e)

PASS = FAIL = 0


def ok(name: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}" + (f"  — {str(extra)[:400]}" if extra else ""))


def raises(fn, exc=Exception) -> str | None:
    try:
        fn()
    except exc as e:  # noqa: BLE001
        return str(e) or type(e).__name__
    return None


class FakeEnv:
    """Records exec/upload calls. `answer(command) -> (rc, stdout)` scripts probes."""

    def __init__(self, answer=None):
        self.calls: list[dict] = []
        self.uploads: list[tuple[str, str, bytes]] = []
        self.default_user = None
        self._answer = answer or (lambda cmd: (0, ""))

    async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
        self.calls.append({"command": command, "user": user, "env": env})
        rc, out = self._answer(command)
        return SimpleNamespace(return_code=rc, stdout=out, stderr="")

    async def upload_file(self, source_path, target_path):
        self.uploads.append((str(source_path), target_path, Path(source_path).read_bytes()))

    def ran(self, needle: str) -> list[dict]:
        return [c for c in self.calls if needle in c["command"]]


def agent(model="anthropic/claude-opus-5", **kw) -> A.ForgeAgent:
    return A.ForgeAgent(logs_dir=Path(tempfile.mkdtemp()), model_name=model, **kw)


def probe(node: bool, machine="x86_64", libc="glibc"):
    def answer(cmd: str):
        if "process.versions.node" in cmd:
            return (0 if node else 1, "")
        if "uname -m" in cmd:
            return (0, f"{machine}\n{libc}\n")
        return (0, "")
    return answer


ROOT = C.DEFAULT_FORGE_ROOT

print("#### CORE (no harbor needed) ####")
print("== model names ==")
ok("provider/model", C.split_model("anthropic/claude-opus-5") == ("anthropic", "claude-opus-5"))
ok("split once: OpenRouter ids keep their slash", C.split_model("openrouter/anthropic/claude-x") == ("openrouter", "anthropic/claude-x"))
for bad in (None, "", "claude-opus-5", "anthropic/"):
    ok(f"rejects {bad!r}", raises(lambda b=bad: C.split_model(b), ValueError) is not None)

print("== the run command ==")
nasty = "--help me; rm -rf / $(whoami) `id` 'quoted' \"double\"\nsecond line"
cmd = C.build_run_command(instruction=nasty, forge_provider="anthropic", model_id="m", base_url="http://x:1", max_steps=7, deep=True)
head, _, tail = cmd.partition(" </dev/null")
argv = shlex.split(head)
ok("the instruction survives quoting byte for byte", argv[-1] == nasty, argv[-1])
ok("…after a -- so it cannot be read as a flag", argv[-2] == "--")
ok("launched through sh -c, which records forge's pid, then execs it", argv[:4] == ["sh", "-c", f'echo $$ > {C.PID_PATH}; exec "$@"', "forge"], argv[:4])
ok("headless and yolo", argv[4:8] == [C.REMOTE_BIN, "agent", "--headless", "--yolo"], argv[4:8])
ok("provider, model, base url, steps, deep", all(x in argv for x in ("--provider", "anthropic", "--model", "m", "--base-url", "http://x:1", "--max-steps", "7", "--deep")))
ok("result file under /logs/agent", f"/logs/agent/{C.RESULT_FILENAME}" in argv)
ok("stdin closed, output tee'd to the log", tail.startswith(" 2>&1 | tee ") and C.LOG_FILENAME in tail, tail)
plain = shlex.split(C.build_run_command(instruction="x", forge_provider="openai", model_id="m").partition(" </dev/null")[0])
ok("optional flags are omitted when unset", not any(f in plain for f in ("--base-url", "--max-steps", "--deep")), plain)

print("== the task's MCP servers (v154) ==")
from types import SimpleNamespace as _NS
ok("no servers: no config, no command", C.mcp_config([]) is None and C.mcp_config(None) is None and C.build_mcp_config_command([]) is None)
tsk = [
    _NS(name="files", transport="stdio", url=None, command="npx", args=["-y", "srv", "it's"]),
    _NS(name="api", transport="streamable-http", url="http://mcp-server:8000/mcp", command=None, args=[]),
    {"name": "old", "transport": "sse", "url": "http://mcp-server:8000/sse"},
]
mc = C.mcp_config(tsk)
ok("stdio: command and args", mc["mcpServers"]["files"] == {"type": "stdio", "command": "npx", "args": ["-y", "srv", "it's"]}, mc)
ok("streamable-http is forge's http", mc["mcpServers"]["api"] == {"type": "http", "url": "http://mcp-server:8000/mcp"}, mc)
ok("sse passes through — forge speaks it since v162", mc["mcpServers"]["old"] == {"type": "sse", "url": "http://mcp-server:8000/sse"}, mc)
ok("Harbor's default transport (unset) is sse", C.mcp_config([{"name": "d", "url": "http://x/sse"}])["mcpServers"]["d"]["type"] == "sse")
wc = C.build_mcp_config_command(tsk)
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "m.json"
    r = _sp_run = __import__("subprocess").run(["sh", "-c", C.build_mcp_config_command(tsk, path=str(out))])
    ok("the write command survives sh quoting (an apostrophe in an arg)", r.returncode == 0 and json.loads(out.read_text()) == mc)
ok("written under /logs/agent by default", wc.endswith(f"> {C.MCP_CONFIG_PATH}"), wc)
with_mcp = shlex.split(C.build_run_command(instruction="x", forge_provider="openai", model_id="m", mcp_config_path=C.MCP_CONFIG_PATH).partition(" </dev/null")[0])
i = with_mcp.index("--mcp-config") if "--mcp-config" in with_mcp else -1
ok("--mcp-config FILE before the --", i > 0 and with_mcp[i + 1] == C.MCP_CONFIG_PATH and i < with_mcp.index("--"), with_mcp)
ok("…and absent without servers", "--mcp-config" not in plain)

print("== stopping forge when Harbor's timeout fires (v151) ==")
import subprocess as _sp
import time as _time
sc = C.STOP_COMMAND
ok("no pkill — procps is missing from minimal images", "pkill" not in sc)
ok("SIGTERM first (forge writes its final record), SIGKILL only after", sc.index("kill -TERM") < sc.index("kill -KILL"))
ok("the wait is bounded (50 × 0.1s)", "seq 50" in sc and "sleep 0.1" in sc)
ok("it always exits 0 — a stop that fails must not become the error", sc.count("exit 0") >= 3 and sc.rstrip().endswith("exit 0"))
ok("a zombie counts as gone", '/proc/$p/stat' in sc and '= Z ]' in sc)
ok("POSIX sh parses it", _sp.run(["sh", "-n", "-c", sc]).returncode == 0)
with tempfile.TemporaryDirectory() as tmp:
    pidf = Path(tmp) / "forge.pid"
    live = sc.replace(C.PID_PATH, str(pidf))
    victim = _sp.Popen(["sh", "-c", "trap 'exit 7' TERM; while :; do sleep 0.05; done"])
    pidf.write_text(str(victim.pid))
    t0 = _time.time()
    rc = _sp.run(["sh", "-c", live]).returncode
    ok("it stops a real process by the pid on file", victim.wait(timeout=5) == 7 and rc == 0, f"rc={rc}")
    # The victim is OUR child and we have not reaped it yet: it is a zombie
    # when the stop command looks — exactly the re-parented case in a task
    # container whose PID 1 never reaps.
    ok(f"…and returns once it is gone, zombie included ({_time.time() - t0:.2f}s, not the full 5s)", _time.time() - t0 < 3)
    pidf.unlink()
    t0 = _time.time()
    ok("no pid file: exits 0 at once", _sp.run(["sh", "-c", live]).returncode == 0 and _time.time() - t0 < 1)
    stubborn = _sp.Popen(["sh", "-c", "trap '' TERM; while :; do sleep 0.05; done"])
    pidf.write_text(str(stubborn.pid))
    _sp.run(["sh", "-c", live])
    ok("a process that ignores SIGTERM is killed after the bounded wait", stubborn.wait(timeout=10) == -9)

print("== the result maps onto Harbor's context ==")
res = {"forge": "149.0.0", "status": "INCOMPLETE", "reason": "RESOURCE_LIMIT", "steps": 12, "toolCalls": 9, "costUsd": None, "error": None,
       "usage": {"inputTokens": 1000, "outputTokens": 200, "cacheReadTokens": 600, "cacheWriteTokens": 50, "estimated": False}}
ctx = C.context_from_result(res)
ok("input = all input (cache included)", ctx["n_input_tokens"] == 1000)
ok("cache = cache reads", ctx["n_cache_tokens"] == 600)
ok("output", ctx["n_output_tokens"] == 200)
ok("cost stays None", ctx["cost_usd"] is None)
ok("forge's own status travels in metadata", ctx["metadata"]["forge_status"] == "INCOMPLETE" and ctx["metadata"]["forge_steps"] == 12)
ok("a result without checks carries None, not a guess", ctx["metadata"]["forge_checks"] is None)
checks = {"checksRun": 1, "checksPassing": 0, "lastCheck": {"command": "npm test", "exitCode": 1, "passed": False, "timedOut": False, "tail": "1 test failed"}}
ok("v181: the checks the run ran travel in metadata", C.context_from_result({**res, "checks": checks})["metadata"]["forge_checks"] == checks)
mcp = {"servers": [{"name": "github", "tools": 0, "error": "no token"}], "skipped": [{"name": "ws", "reason": "websocket", "file": "b.json"}]}
ok("v200: the run's MCP servers travel in metadata", C.context_from_result({**res, "mcp": mcp})["metadata"]["forge_mcp"] == mcp)
ok("v200: …None when the run had none", ctx["metadata"]["forge_mcp"] is None)
print("== what gets installed ==")
pkg = json.loads((ROOT / "package.json").read_text())
files = [p.relative_to(ROOT).as_posix() for p in C.forge_package_files(ROOT)]
ok("package.json itself", "package.json" in files)
ok("every plain entry in files[]", all(f in files for f in pkg["files"] if not f.endswith("/")))
ok("nothing outside files[] (no tests, no .git)", not any(f.startswith(("tests/", ".git")) for f in files))
names = set(tarfile.open(fileobj=io.BytesIO(C.build_forge_tarball(ROOT))).getnames())
ok("the tarball holds exactly those files", names == set(files), f"{len(names)} vs {len(files)}")
ok("…including the adapter itself (an npm install can find it)", "integrations/harbor/forge_harbor/agent.py" in names)

print("== the pinned Node ==")
with tempfile.TemporaryDirectory() as tmp:
    cache = Path(tmp)
    body = b"not really node"
    good = hashlib.sha256(body).hexdigest()
    saved_hash, saved_open = dict(C.NODE_SHA256), C.urllib.request.urlopen
    served = {"n": 0, "body": body}

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_open(url, timeout=None):
        served["n"] += 1
        served["url"] = url
        return Resp(served["body"])

    try:
        C.NODE_SHA256["x64"] = good
        C.urllib.request.urlopen = fake_open
        p = C.node_tarball("x64", cache)
        ok("downloads and verifies", p.read_bytes() == body and served["n"] == 1)
        ok("from nodejs.org, the pinned version", served["url"] == f"https://nodejs.org/dist/{C.NODE_VERSION}/node-{C.NODE_VERSION}-linux-x64.tar.gz", served["url"])
        C.node_tarball("x64", cache)
        ok("a verified cache is reused", served["n"] == 1)
        p.write_bytes(b"tampered")
        C.node_tarball("x64", cache)
        ok("a tampered cache is replaced, not uploaded", served["n"] == 2 and p.read_bytes() == body)
        p.unlink()
        served["body"] = b"wrong bytes"
        err = raises(lambda: C.node_tarball("x64", cache), RuntimeError)
        ok("a download that does not match the pinned hash is refused", err is not None and "does not match" in err, err)
        ok("…and leaves nothing behind", list(cache.iterdir()) == [], list(cache.iterdir()))
        ok("an unknown arch is refused", raises(lambda: C.node_tarball("riscv64", cache), ValueError) is not None)
    finally:
        C.NODE_SHA256.clear()
        C.NODE_SHA256.update(saved_hash)
        C.urllib.request.urlopen = saved_open

w = C.WRAPPER
ok("the wrapper prefers the uploaded runtime", w.index(f"{C.REMOTE_NODE_DIR}/bin/node") < w.index("nvm.sh"))
ok("…and never puts it on the task's PATH", "PATH=" not in w)


if HARBOR:
    print("#### AGENT (real harbor base classes) ####")
    print("== construction ==")
    a = agent(max_steps=40)
    ok("name is forge", A.ForgeAgent.name() == "forge")
    ok("options parse", a.options.max_steps == 40 and a.options.deep is False and a.options.node_install == "upload")
    ok("max_steps is bounded", raises(lambda: agent(max_steps=0)) is not None and raises(lambda: agent(max_steps=1001)) is not None)
    ok("node_install is one of upload|nvm", raises(lambda: agent(node_install="apt")) is not None)
    ok("gzip is a known system package (tar -xz shells out to it)", "gzip" in A.ForgeAgent.SYSTEM_PACKAGES)

    a2 = agent()
    (a2.logs_dir / A.RESULT_FILENAME).write_text(json.dumps(res))
    c2 = SimpleNamespace()
    a2.populate_context_post_run(c2)
    ok("populate_context_post_run reads the file forge wrote", getattr(c2, "n_input_tokens", None) == 1000)
    a3 = agent()
    (a3.logs_dir / A.RESULT_FILENAME).write_text("{ not json")
    c3 = SimpleNamespace()
    a3.populate_context_post_run(c3)
    ok("…and ignores a broken one rather than failing the trial", not hasattr(c3, "n_input_tokens"))

    print("== install ==")
    saved_nt = A.node_tarball
    fake_node = Path(tempfile.mkdtemp()) / "node.tgz"
    fake_node.write_bytes(b"node!")
    A.node_tarball = lambda arch, cache_dir=None: fake_node
    try:
        env = FakeEnv(probe(node=True))
        asyncio.run(agent().install(env))
        ok("image has Node >= 20: no runtime uploaded, no nvm", not any(u[1] == "/installed-agent/node.tgz" for u in env.uploads) and not env.ran("nvm"))
        ok("…forge's tarball and wrapper uploaded", {u[1] for u in env.uploads} == {"/installed-agent/forge.tgz", "/installed-agent/forge-wrapper"})
        ex = env.ran(f"tar -xzf /installed-agent/forge.tgz -C {A.REMOTE_DIR}")
        ok("…unpacked as root", len(ex) == 1 and ex[0]["user"] == "root")
        ok("…and the installed forge is run once to prove it starts", len(env.ran(f"{A.REMOTE_BIN} --version")) == 1)
        ok("no apt-get: nothing asked for is missing", not env.ran("apt-get"))

        env = FakeEnv(probe(node=False))
        asyncio.run(agent().install(env))
        up = [u for u in env.uploads if u[1] == "/installed-agent/node.tgz"]
        ok("no Node: the pinned runtime is uploaded", len(up) == 1 and up[0][2] == b"node!")
        ok("…unpacked into its own directory", len(env.ran(f"--strip-components=1")) == 1)
        ok("…and never fetched from inside the task", not env.ran("curl") and not env.ran("nvm"))

        err = raises(lambda: asyncio.run(agent().install(FakeEnv(probe(node=False, libc="musl")))), RuntimeError)
        ok("a musl image is refused, with the reason", err is not None and "musl" in err, err)
        err = raises(lambda: asyncio.run(agent().install(FakeEnv(probe(node=False, machine="riscv64")))), RuntimeError)
        ok("an unknown architecture is refused", err is not None and "riscv64" in err, err)

        env = FakeEnv(probe(node=False))
        asyncio.run(agent(node_install="nvm").install(env))
        ok("node_install=nvm uses Harbor's nvm helper instead", len(env.ran("nvm install")) == 1 and not any(u[1] == "/installed-agent/node.tgz" for u in env.uploads))
    finally:
        A.node_tarball = saved_nt

    print("== a timeout stops forge, and the timeout still wins (v151) ==")

    class HangingEnv(FakeEnv):
        """The forge command never returns — until the run is cancelled."""

        def __init__(self, stop=lambda: (0, "")):
            super().__init__()
            self.started = asyncio.Event()
            self._stop = stop

        async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
            self.calls.append({"command": command, "user": user, "env": env})
            if "agent --headless" in command:
                self.started.set()
                await asyncio.Event().wait()
            if command == A.STOP_COMMAND:
                r = self._stop()
                if isinstance(r, BaseException):
                    raise r
                if r == "hang":
                    await asyncio.Event().wait()
                rc, out = r
                return SimpleNamespace(return_code=rc, stdout=out, stderr="")
            return SimpleNamespace(return_code=0, stdout="", stderr="")

    async def timed_out(env, stop_timeout=None):
        os.environ["ANTHROPIC_API_KEY"] = "k"
        ag = agent()
        if stop_timeout is not None:
            ag._stop_timeout_sec = stop_timeout
        task = asyncio.create_task(ag.run("do it", env, SimpleNamespace()))
        await asyncio.wait_for(env.started.wait(), timeout=5)
        t0 = _time.time()
        # What Harbor's asyncio.wait_for does when the agent timeout fires.
        task.cancel()
        try:
            await task
            return "returned", _time.time() - t0
        except asyncio.CancelledError:
            return "cancelled", _time.time() - t0
        except BaseException as e:  # noqa: BLE001
            return f"raised {type(e).__name__}", _time.time() - t0

    saved_key = os.environ.get("ANTHROPIC_API_KEY")
    try:
        env = HangingEnv()
        outcome, _ = asyncio.run(timed_out(env))
        ok("the cancellation propagates — Harbor still records the timeout", outcome == "cancelled", outcome)
        ok("…after forge was told to stop, in the container", len([c for c in env.calls if c["command"] == A.STOP_COMMAND]) == 1)

        env = HangingEnv(stop=lambda: RuntimeError("container gone"))
        outcome, _ = asyncio.run(timed_out(env))
        ok("a stop that fails still lets the cancellation through", outcome == "cancelled", outcome)

        env = HangingEnv(stop=lambda: "hang")
        outcome, took = asyncio.run(timed_out(env, stop_timeout=0.3))
        ok(f"a stop that hangs is bounded ({took:.2f}s)", outcome == "cancelled" and took < 2, f"{outcome} {took:.2f}")

        class FailingEnv(FakeEnv):
            async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
                self.calls.append({"command": command, "user": user, "env": env})
                if "agent --headless" in command:
                    return SimpleNamespace(return_code=1, stdout="", stderr="boom")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

        env = FailingEnv()
        err = raises(lambda: asyncio.run(agent().run("x", env, SimpleNamespace())))
        ok("an ordinary failure is reported as itself", err is not None, err)
        ok("…and does NOT run the stop (only a cancellation does)", not [c for c in env.calls if c["command"] == A.STOP_COMMAND])
    finally:
        if saved_key is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = saved_key

    print("== run ==")
    saved_env = dict(os.environ)
    try:
        for k in list(os.environ):
            if k.endswith(("_API_KEY", "_BASE_URL")) or k in ("HF_TOKEN",):
                del os.environ[k]
        os.environ["GOOGLE_API_KEY"] = "g-secret"
        os.environ["GOOGLE_BASE_URL"] = "https://proxy.example/v1"
        env = FakeEnv()
        asyncio.run(agent(model="gemini/gemini-3-pro").run("do it", env, SimpleNamespace()))
        run = env.ran("agent --headless")
        ok("one forge run", len(run) == 1)
        c = run[0]
        ok("gemini (aliased to google by Harbor) runs as forge's gemini", "--provider gemini" in c["command"], c["command"])
        ok("the key goes under the name forge reads", (c["env"] or {}).get("GEMINI_API_KEY") == "g-secret", c["env"])
        ok("…and never onto the command line", "g-secret" not in c["command"])
        ok("a configured base URL is passed through", "--base-url https://proxy.example/v1" in c["command"])
        ok("colour off for the log", (c["env"] or {}).get("NO_COLOR") == "1")

        ok("no task servers: nothing written, no --mcp-config", not env.ran("forge-mcp.json"))

        from harbor.models.task.config import MCPServerConfig
        env = FakeEnv()
        servers = [MCPServerConfig(name="taskmcp", transport="stdio", command="node", args=["/srv.mjs"]),
                   MCPServerConfig(name="api", transport="streamable-http", url="http://mcp-server:8000/mcp")]
        asyncio.run(agent(model="gemini/gemini-3-pro", mcp_servers=servers).run("do it", env, SimpleNamespace()))
        wrote = env.ran(A.MCP_CONFIG_PATH)
        ok("task servers: the config is written, then forge runs with it", len(wrote) == 2 and "printf " in wrote[0]["command"] and "sh -c" not in wrote[0]["command"] and "--mcp-config" in wrote[1]["command"], [w["command"][:60] for w in wrote])
        ok("…the written JSON is Harbor's servers", A.mcp_config(servers)["mcpServers"]["taskmcp"]["command"] == "node" and "mcp-server:8000" in wrote[0]["command"])

        os.environ["COHERE_API_KEY"] = "c"
        err = raises(lambda: asyncio.run(agent(model="cohere/command-x").run("x", FakeEnv(), SimpleNamespace())), ValueError)
        ok("a provider forge has no mapping for is refused, listing the supported ones", err is not None and "anthropic" in err and "cohere" in err, err)
    finally:
        os.environ.clear()
        os.environ.update(saved_env)

else:
    print(f"harbor half: skipped — {HARBOR_WHY}")

print(f"\n== harbor-adapter tests: {PASS} passed, {FAIL} failed ==")
sys.exit(1 if FAIL else 0)
