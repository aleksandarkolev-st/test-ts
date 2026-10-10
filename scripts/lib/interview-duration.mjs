import assert from 'node:assert/strict';

export function interviewBudget(env) {
  const minutes=env.COPILOT_NATIVE_INTERVIEW_MINUTES===undefined?null:Number(env.COPILOT_NATIVE_INTERVIEW_MINUTES);
  assert(minutes===null||(Number.isFinite(minutes)&&minutes>0&&minutes<=240),'Interview duration must be above zero and at most 240 minutes');
  const rounds=Number(env.COPILOT_NATIVE_INTERVIEW_ROUNDS??(minutes===null?12:1000));
  assert(Number.isInteger(rounds)&&rounds>0&&rounds<=(minutes===null?100:1000),'Invalid interview round cap');
  return {rounds,durationMs:minutes===null?null:minutes*60000};
}

export function continueInterview({rounds,durationMs},nextRound,elapsedMs) {
  return nextRound<=rounds&&(nextRound===1||durationMs===null||elapsedMs<durationMs);
}

export function interviewStopReason({rounds,durationMs},completedRounds,elapsedMs) {
  if(durationMs!==null&&elapsedMs>=durationMs)return 'duration_reached';
  if(completedRounds>=rounds)return durationMs===null?'rounds_reached':'round_cap_before_duration';
  return 'incomplete';
}
