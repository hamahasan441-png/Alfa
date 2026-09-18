/**
 * Forge 122.7 — bounded next-level intelligence primitives.
 * Deterministic/advisory only: no authority bypass, no direct tool execution.
 */
export const INTELLIGENCE_NEXT_VERSION = "1.0.0"
const clamp=(n,a,b)=>Math.max(a,Math.min(b,Number(n)||0))
const toks=s=>new Set(String(s||'').toLowerCase().match(/[a-z0-9_]{3,}/g)||[])
const overlap=(a,b)=>{const A=toks(a),B=toks(b); if(!A.size&&!B.size)return 1; let n=0; for(const x of A)if(B.has(x))n++; return n/Math.max(1,A.size,B.size)}

export function metaReason({objective='', observations=[], failures=[], constraints=[]}={}){
  const signals=[...observations,...failures].map(String)
  const uncertainty=clamp((signals.filter(x=>/unknown|uncertain|ambiguous|failed|error/i.test(x)).length+constraints.length)/(signals.length+constraints.length+1),0,1)
  const next=uncertainty>.55?'investigate':failures.length?'repair':'execute'
  return {version:INTELLIGENCE_NEXT_VERSION, objective:String(objective).slice(0,1000), uncertainty, mode:next, rationale: uncertainty>.55?'uncertainty is high':failures.length?'recent failures require repair':'evidence supports execution'}
}

export function longHorizonPlan({nodes=[], maxFrontier=4}={}){
  const ns=(nodes||[]).map((n,i)=>({id:String(n.id||`h-${i+1}`), objective:String(n.objective||n.text||'').slice(0,300), deps:[...(n.dependencies||n.deps||[])], done:n.done===true}))
  const done=new Set(ns.filter(n=>n.done).map(n=>n.id))
  const frontier=ns.filter(n=>!n.done&&n.deps.every(d=>done.has(d))).slice(0,maxFrontier).map(n=>n.id)
  return {version:INTELLIGENCE_NEXT_VERSION,nodes:ns,frontier,blocked:ns.filter(n=>!n.done&&!frontier.includes(n.id)).map(n=>n.id),complete:ns.length>0&&ns.every(n=>n.done)}
}

export function regressionRisk({changedFiles=[], historicalFailures=[], tests=[]}={}){
  const files=[...new Set(changedFiles.map(String))]; const hot=new Set(historicalFailures.map(x=>typeof x==='string'?x:x.file).filter(Boolean))
  const touchedHot=files.filter(f=>[...hot].some(h=>f===h||f.startsWith(h+'/')||h.startsWith(f+'/')))
  const failing=tests.filter(t=>t&&t.passed===false).length
  const score=clamp(touchedHot.length*.25+failing*.2+(files.length>20?.15:files.length>8?.08:0),0,1)
  return {version:INTELLIGENCE_NEXT_VERSION,score,level:score>=.7?'HIGH':score>=.35?'MEDIUM':'LOW',touchedHot,failingTests:failing}
}

export function generateTests({requirements=[], changedFiles=[], knownFailures=[]}={}){
  const reqs=[...new Set(requirements.map(String).filter(Boolean))].slice(0,20)
  const out=reqs.map((r,i)=>({id:`gen-${i+1}`,requirement:r,kind:/security|auth|permission/i.test(r)?'boundary':/error|fail|retry/i.test(r)?'failure-path':'behavior',priority:/must|required|never|always/i.test(r)?'high':'normal',status:'PROPOSED'}))
  for(const f of knownFailures.slice(0,10)) out.push({id:`gen-f-${out.length+1}`,requirement:`regression: ${typeof f==='string'?f:f.message||f.file||'known failure'}`,kind:'regression',priority:'high',status:'PROPOSED'})
  return {version:INTELLIGENCE_NEXT_VERSION,tests:out,executable:false,reason:'proposals require project-specific test implementation and verification'}
}

export function edgeCases({objective='', constraints=[], inputs=[]}={}){
  const base=['empty input','missing optional data','duplicate input','maximum-size input','unexpected ordering','partial failure','interrupted execution']
  const security=constraints.some(c=>/secret|auth|permission|network/i.test(String(c)))?['unauthorized input','secret-like input','network failure']:[]
  return {version:INTELLIGENCE_NEXT_VERSION,cases:[...new Set([...base,...security,...inputs.map(x=>String(x))])].slice(0,24),objective:String(objective).slice(0,300)}
}

export function selectStrategy({candidates=[], evidence=[], resources={}}={}){
  const ev=evidence.join(' '); const scored=candidates.map((c,i)=>{const s=clamp((Number(c.confidence)||0)*.5+overlap(c.strategy||c.name,ev)*.3+(Number(c.successRate)||0)*.2,0,1); return {...c,score:s}}).sort((a,b)=>b.score-a.score)
  return {version:INTELLIGENCE_NEXT_VERSION,candidates:scored,selected:null,requiresPolicySelection:true,resources}
}

export function memoryConsolidate({episodes=[], max=64}={}){
  const seen=new Set(), out=[]
  for(const e of [...episodes].reverse()){const key=String(e.key||e.objective||e.id||JSON.stringify(e)).slice(0,300); if(seen.has(key))continue; seen.add(key); out.push({...e,consolidated:true})}
  return {version:INTELLIGENCE_NEXT_VERSION,episodes:out.slice(0,max).reverse(),bounded:true}
}

export function multiAgentSchedule({agents=[], dependencies=[], maxParallel=3}={}){
  const ids=[...new Set(agents.map(a=>typeof a==='string'?a:a.id).filter(Boolean))]; const dep=new Map(ids.map(id=>[id,new Set()])); for(const d of dependencies){if(dep.has(d.to)&&dep.has(d.from))dep.get(d.to).add(d.from)}
  const ready=ids.filter(id=>dep.get(id).size===0).slice(0,Math.max(1,maxParallel));
  return {version:INTELLIGENCE_NEXT_VERSION,agents:ids,ready,serialized:ids.filter(id=>!ready.includes(id)),singleWriter:true,conflictPolicy:'coordinate-before-write'}
}

export function benchmarkMatrix(){
  return {version:INTELLIGENCE_NEXT_VERSION,categories:['simple-code','bug-fix','multi-file','repo-understanding','long-horizon','adaptive-recovery','testing','verification','regression','resource-stress','goal-drift','adversarial-review','checkpoint-resume','strategy-selection','real-agent-e2e'], scoring:['correctness','goal-preservation','verification','regression','recovery','time','resource-use','false-completion'],providerRequiredForLive:true}
}
