/** Forge 122.8 — advanced intelligence, advisory and evidence-first. */
export const ADVANCED_INTELLIGENCE_VERSION='1.0.0'
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,Number(n)||0))
const norm=p=>String(p||'').replaceAll('\\','/').replace(/^\.\//,'')
const words=s=>new Set(String(s||'').toLowerCase().match(/[a-z0-9_]{3,}/g)||[])
const sim=(a,b)=>{const A=words(a),B=words(b); if(!A.size||!B.size)return 0; let n=0; for(const x of A)if(B.has(x))n++; return n/Math.max(A.size,B.size)}

export function repositoryIntelligence({files=[],imports=[],objective='',historicalFailures=[]}={}){
 const fs=[...new Set(files.map(norm).filter(Boolean))]; const edges=imports.map(x=>({from:norm(x.from),to:norm(x.to)})).filter(x=>x.from&&x.to&&fs.includes(x.from)&&fs.includes(x.to));
 const affected=new Set(fs.filter(f=>sim(f,objective)>=.15)); for(const e of edges)if(affected.has(e.to))affected.add(e.from)
 const hot=new Set(historicalFailures.map(x=>norm(typeof x==='string'?x:x.file)).filter(Boolean));
 return {version:ADVANCED_INTELLIGENCE_VERSION,files:fs,edges,objective:String(objective).slice(0,500),affected:[...affected],hotFiles:fs.filter(f=>hot.has(f)),impactRadius:affected.size}
}

export function hypothesisExperiment({hypothesis='',expected='',observations=[],cost=1}={}){
 const obs=observations.map(String); const contradictions=obs.filter(x=>expected&&sim(x,expected)<.12).length; const support=obs.filter(x=>expected&&sim(x,expected)>=.35).length;
 return {version:ADVANCED_INTELLIGENCE_VERSION,hypothesis:String(hypothesis).slice(0,500),expected:String(expected).slice(0,500),support,contradictions,confidence:clamp(.5+support*.12-contradictions*.18-Number(cost)*.02),decision:contradictions>support?'REJECT':support?'CONTINUE':'NEED_EVIDENCE'}
}

export function regressionSuite({changedFiles=[],tests=[],impactFiles=[],historicalFailures=[]}={}){
 const changed=new Set(changedFiles.map(norm)); const impact=new Set(impactFiles.map(norm)); const hot=new Set(historicalFailures.map(x=>norm(typeof x==='string'?x:x.file)).filter(Boolean));
 const selected=tests.filter(t=>{const touched=(t.files||t.paths||[]).map(norm); return !touched.length || touched.some(f=>[...changed,...impact,...hot].some(x=>f===x||f.startsWith(x+'/')||x.startsWith(f+'/')))||t.regression===true}).map(t=>t.id||t.name).filter(Boolean)
 return {version:ADVANCED_INTELLIGENCE_VERSION,selected:[...new Set(selected)],reason:'impact/historical/regression evidence',totalTests:tests.length}
}

export function synthesizeTestCases({requirements=[],edgeCases=[],existingTests=[]}={}){
 const existing=new Set(existingTests.map(x=>String(x).toLowerCase())); const out=[]; for(const r of requirements.slice(0,24)){for(const e of edgeCases.slice(0,8)){const name=`${r} :: ${e}`; if(!existing.has(name.toLowerCase()))out.push({id:`case-${out.length+1}`,requirement:String(r).slice(0,220),scenario:String(e).slice(0,180),status:'PROPOSED'})}}
 return {version:ADVANCED_INTELLIGENCE_VERSION,cases:out.slice(0,64),executable:false,requiresProjectTestHarness:true}
}

export function consolidateMemory({episodes=[],max=96}={}){
 const groups=new Map(); for(const e of episodes){const k=String(e.key||e.objective||e.id||'').slice(0,240); if(!k)continue; const g=groups.get(k)||[]; g.push(e); groups.set(k,g)}
 const consolidated=[...groups.entries()].map(([key,es])=>({key,count:es.length,last:es[es.length-1],contradictions:es.filter(x=>x.outcome==='FAIL').length>0&&es.some(x=>x.outcome==='PASS')})).slice(-max)
 return {version:ADVANCED_INTELLIGENCE_VERSION,items:consolidated,bounded:true}
}

export function multiAgentWaves({agents=[],dependencies=[]}={}){
 const ids=[...new Set(agents.map(a=>typeof a==='string'?a:a.id).filter(Boolean))]; const dep=new Map(ids.map(id=>[id,new Set()])); for(const d of dependencies)if(dep.has(d.to)&&dep.has(d.from))dep.get(d.to).add(d.from)
 const done=new Set(),waves=[]; for(let guard=0;guard<ids.length&&guard<ids.length+2;guard++){const wave=ids.filter(id=>!done.has(id)&&[...dep.get(id)].every(x=>done.has(x))); if(!wave.length)break; waves.push(wave); wave.forEach(x=>done.add(x))}
 return {version:ADVANCED_INTELLIGENCE_VERSION,waves,blocked:ids.filter(x=>!done.has(x)),singleWriter:true,requiresCoordinator:true}
}
