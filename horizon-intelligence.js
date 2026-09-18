/** Forge 122.9 — long-horizon execution integrity and adaptive frontier intelligence. */
export const HORIZON_INTELLIGENCE_VERSION = "1.0.0"
const clean = (v, n=300) => String(v ?? "").trim().slice(0,n)
const uniq = a => [...new Set((a||[]).map(String).filter(Boolean))]

/** Validate a task DAG without executing anything. */
export function validateHorizonGraph({nodes=[]}={}) {
  const ns = nodes.map((n,i)=>({id:String(n.id||`node-${i+1}`), deps:uniq(n.dependencies||n.deps), done:n.done===true}))
  const ids=new Set(ns.map(n=>n.id)); const errors=[]
  for(const n of ns){ for(const d of n.deps){ if(!ids.has(d)) errors.push({node:n.id,type:"MISSING_DEPENDENCY",dependency:d}) } }
  const color=new Map(), cycle=[]
  const visit=id=>{ const c=color.get(id)||0; if(c===1){cycle.push(id);return true} if(c===2)return false; color.set(id,1); const n=ns.find(x=>x.id===id); for(const d of n?.deps||[]) if(ids.has(d)&&visit(d)) return true; color.set(id,2); return false }
  for(const id of ids) if(visit(id)) break
  if(cycle.length) errors.push({node:cycle.at(-1),type:"CYCLE",path:cycle})
  return {version:HORIZON_INTELLIGENCE_VERSION,valid:errors.length===0,errors,nodeCount:ns.length}
}

/** Produce a bounded executable frontier while preserving dependency barriers. */
export function adaptiveFrontier({nodes=[],completed=[],failed=[],maxParallel=3}={}) {
  const ns=nodes.map((n,i)=>({id:String(n.id||`node-${i+1}`),deps:uniq(n.dependencies||n.deps),priority:Number(n.priority)||0}))
  const done=new Set(uniq(completed)); const blocked=new Set(uniq(failed));
  const graph=validateHorizonGraph({nodes:ns});
  if(!graph.valid) return {version:HORIZON_INTELLIGENCE_VERSION,frontier:[],blocked:[...new Set(ns.map(n=>n.id))],reason:"INVALID_GRAPH",graph}
  const ready=ns.filter(n=>!done.has(n.id)&&!blocked.has(n.id)&&n.deps.every(d=>done.has(d)))
    .sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id)).slice(0,Math.max(1,Math.min(8,Number(maxParallel)||3)))
  return {version:HORIZON_INTELLIGENCE_VERSION,frontier:ready.map(n=>n.id),blocked:ns.filter(n=>!done.has(n.id)&&!ready.some(r=>r.id===n.id)).map(n=>n.id),complete:ns.length>0&&ns.every(n=>done.has(n.id)),graph}
}

/** Turn observations into a bounded replan decision; never executes or changes authority. */
export function horizonDecision({objective="",frontier=[],failures=[],evidence=[],budget={}}={}) {
  const f=uniq(frontier), fails=uniq(failures), ev=uniq(evidence)
  const exhausted = budget && ((Number(budget.stepsLeft) <= 0) || (Number(budget.timeLeftMs) <= 0))
  const action = exhausted ? "CHECKPOINT" : fails.length ? "REPLAN" : f.length ? "CONTINUE" : ev.length ? "VERIFY" : "INVESTIGATE"
  return {version:HORIZON_INTELLIGENCE_VERSION,objective:clean(objective),action,frontier:f.slice(0,8),failureCount:fails.length,evidenceCount:ev.length,budgetExhausted:!!exhausted}
}

/** Persist only bounded, serialisable horizon state for safe resume. */
export function checkpointHorizon({nodes=[],completed=[],failed=[],attempt=0,maxHistory=32}={}) {
  return {version:HORIZON_INTELLIGENCE_VERSION,nodes:nodes.slice(0,256),completed:uniq(completed).slice(-256),failed:uniq(failed).slice(-256),attempt:Math.max(0,Number(attempt)||0),historyLimit:maxHistory,resumable:true}
}
/** Recompute the horizon after observed progress; deterministic and advisory. */
export function advanceHorizon({nodes=[],completed=[],failed=[],evidence=[],attempt=0,budget={}}={}) {
  const frontier = adaptiveFrontier({ nodes, completed, failed, maxParallel: budget?.maxParallel || 3 })
  const decision = horizonDecision({
    objective: budget?.objective || "",
    frontier: frontier.frontier,
    failures: failed,
    evidence,
    budget,
  })
  const checkpoint = checkpointHorizon({ nodes, completed, failed, attempt })
  return { version:HORIZON_INTELLIGENCE_VERSION, frontier, decision, checkpoint }
}
