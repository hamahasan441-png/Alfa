/**
 * forge — runs docextract.describeFile off the server's thread.
 *
 * Reading an uploaded file is work on bytes someone else chose. In a worker
 * it has its own heap limit and a deadline (docextract.describeFileIsolated
 * terminates it), so a hostile file costs at most that — the web server keeps
 * answering, Stop included.
 */
import { parentPort, workerData } from "node:worker_threads"
import { describeFile } from "./docextract.js"

let result
try { result = describeFile(workerData.abs, workerData.opts) } catch (e) { result = { error: String(e?.message ?? e).slice(0, 200) } }
parentPort.postMessage(result)
