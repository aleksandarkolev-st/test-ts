import test from 'node:test';
import assert from 'node:assert/strict';
import {interviewBudget,continueInterview,interviewStopReason} from '../lib/interview-duration.mjs';

test('duration continues beyond a fixed short round count and stops only at elapsed budget',()=>{
  const budget=interviewBudget({COPILOT_NATIVE_INTERVIEW_MINUTES:'60'});
  assert.equal(budget.durationMs,3600000);
  assert.equal(continueInterview(budget,101,3599999),true);
  assert.equal(continueInterview(budget,102,3600000),false);
  assert.equal(interviewStopReason(budget,101,3600000),'duration_reached');
  assert.equal(interviewStopReason({...budget,rounds:2},2,3000),'round_cap_before_duration');
});

test('untimed benchmarks retain their existing round budget',()=>{
  const budget=interviewBudget({COPILOT_NATIVE_INTERVIEW_ROUNDS:'3'});
  assert.equal(continueInterview(budget,3,4000000),true);
  assert.equal(continueInterview(budget,4,4000000),false);
  assert.equal(interviewStopReason(budget,3,4000000),'rounds_reached');
  for(const minutes of ['0','-1','NaN','Infinity','241'])assert.throws(()=>interviewBudget({COPILOT_NATIVE_INTERVIEW_MINUTES:minutes}));
});
