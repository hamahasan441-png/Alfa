/** Forge 123.1 — evidence-driven horizon risk and verification escalation. */
export const HORIZON_RISK_VERSION = "1.0.0"
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,Number(n)||0))
const norm=s=>String(s??"").replaceAll('\\','/').replace(/^\.\//,'')
const overlap=(a,b)=>{const A=new Set(String(a||'').toLowerCase().match(/[a-z0-9_]{3,}/g)||[]),B=new Set(String(b||'').toLowerCase().match(/[a-z0-9_]{3,}/g)||[]); if(!A.size||!B.size)return 0; let n=0; for(const x of A)if(B.has(x))n++; return n/Math.max(A.size,B.size)}

/** Score each frontier node from explicit regression evidence; never executes or authorizes. */
export function scoreHorizonRisk({nodes=[],changedFiles=[],historicalFailures=[],tests=[]}={}){
  const changed=changedFiles.map(norm).filter(Boolean)
  const hot=new Set(historicalFailures.map(x=>norm(typeof x==='string'?x:x?.file)).filter(Boolean))
  const failing=new Set(tests.filter(t=>t?.passed===false).map(t=>String(t.id||t.name||'')).filter(Boolean))
  const out=nodes.slice(0,8).map((n,i)=>{
    const files=(n.files||n.changedFiles||[]).map(norm).filter(Boolean)
    const touchedHot=files.filter(f=>[...hot].some(h=>f===h||f.startsWith(h+'/')||h.startsWith(f+'/')))
    const relatedTests=(n.tests||[]).map(String).filter(x=>failing.has(x))
    const objective=String(n.objective||n.text||n.id||'')
    const semanticChange=changed.reduce((m,f)=>Math.max(m,overlap(f,objective)),0)
    const score=clamp(touchedHot.length*.3+relatedTests.length*.35+(semanticChange>=.3?.15:0))
    return {id:String(n.id||`node-${i+1}`),score:Number(score.toFixed(3)),level:score>=.7?'HIGH':score>=.35?'MEDIUM':'LOW',touchedHot, failingTests:relatedTests}
  })
  return {version:HORIZON_RISK_VERSION,nodes:out,verification:out.filter(x=>x.level!=='LOW').map(x=>x.id),requiresEscalation:out.some(x=>x.level==='HIGH')}
}
