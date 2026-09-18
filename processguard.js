/** Bounded process lifecycle policy; execution remains owned by the caller. */
export const PROCESS_GUARD_VERSION='1.0.0'
export function shutdownPlan({reason='timeout',graceMs=2000,platform=process.platform}={}){
  const graceful=['timeout','cancel','shutdown'].includes(reason)
  return {version:PROCESS_GUARD_VERSION,reason,signals:graceful?['SIGTERM','SIGKILL']:['SIGKILL'],graceMs:Math.max(0,Number(graceMs)||0),groupKill:platform!=='win32',certainty:reason==='external-kill'?'unknown':'classified'}
}
export function classifyExit({code=null,signal=null,timedOut=false,cancelled=false,oomHint=false}={}){
  if(oomHint||signal==='SIGKILL'&&code===null&&timedOut===false&&cancelled===false)return {kind:'KILLED',cause:oomHint?'OOM_OR_RESOURCE_PRESSURE':'UNKNOWN_SIGKILL'}
  if(timedOut)return {kind:'TIMEOUT',cause:'deadline'}
  if(cancelled)return {kind:'CANCELLED',cause:'user_or_controller'}
  if(signal)return {kind:'SIGNAL',cause:signal}
  return {kind:code===0?'SUCCESS':'EXIT_FAILURE',code}
}
