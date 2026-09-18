/** Forge Horizon Coordinator — deterministic multi-agent wave planning.
 * Advisory only: governor, tool grants, verifier and completion gate remain authoritative.
 */
export const HORIZON_COORDINATOR_VERSION = "1.0.0"
const clean = (v, n=240) => String(v ?? "").slice(0,n)
const norm = (v) => clean(v,300).replace(/\\/g,'/').replace(/^\.\//,'')

export function coordinateHorizon({ nodes=[], completed=[], failed=[], agents=[], maxParallel=3 }={}) {
  const list = Array.isArray(nodes) ? nodes.filter(n=>n?.id).map(n=>({ ...n, id:String(n.id), dependencies:Array.isArray(n.dependencies)?n.dependencies.map(String):[], files:Array.isArray(n.files)?n.files.map(norm).filter(Boolean):[] })) : []
  const done = new Set((Array.isArray(completed)?completed:[]).map(String))
  const bad = new Set((Array.isArray(failed)?failed:[]).map(String))
  const cap = Math.max(1, Math.min(8, Number(maxParallel)||1))
  const ready = list.filter(n=>!done.has(n.id) && !n.dependencies.some(d=>bad.has(d)) && n.dependencies.every(d=>done.has(d)))
  const chosen=[]
  const usedFiles=new Set()
  for (const n of ready.sort((a,b)=>(Number(b.priority)||0)-(Number(a.priority)||0))) {
    if (chosen.length>=cap) break
    if (n.files.some(f=>usedFiles.has(f))) continue
    chosen.push(n)
    for (const f of n.files) usedFiles.add(f)
  }
  const pool=(Array.isArray(agents)?agents:[]).map((a,i)=>typeof a==='string'?{id:a,role:a}:({id:String(a?.id||`agent-${i+1}`),role:clean(a?.role||a?.id||`agent-${i+1}`,80)})).slice(0,cap)
  const assignments=chosen.map((n,i)=>({nodeId:n.id,agentId:pool[i]?.id||null,role:pool[i]?.role||null,files:n.files.slice(0,32)}))
  return {version:HORIZON_COORDINATOR_VERSION, maxParallel:cap, ready:ready.slice(0,32).map(n=>n.id), waves:assignments.length?[assignments]:[], conflicts:ready.filter(n=>n.files.some(f=>chosen.find(c=>c.id!==n.id)?.files.includes(f))).map(n=>n.id).slice(0,32), bounded:true, advisory:true}
}
