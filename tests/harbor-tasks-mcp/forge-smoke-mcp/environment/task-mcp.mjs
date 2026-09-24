// A task's MCP server (stdio, MCP 2024-11-05): one tool, `record`, which
// writes its text to /app/recorded.txt. The verifier checks that file, so
// the task passes only if the agent was given this server AND called it.
import fs from "node:fs"
let buf = ""
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n")
process.stdin.on("data", (d) => {
  buf += d
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id === undefined) continue
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "task", version: "1" } } })
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "record", description: "record text for the verifier", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } })
    else if (m.method === "tools/call") {
      fs.writeFileSync("/app/recorded.txt", String(m.params?.arguments?.text ?? ""))
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "recorded" }] } })
    } else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } })
  }
})
