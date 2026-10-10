// Offline interview grading only; never retries candidate generation.
export async function gradeWithRetry(run,{attempts=1,onAttempt=async()=>{}}={}) {
  if(!Number.isInteger(attempts)||attempts<1||attempts>2)throw Error('Examiner attempts must be 1 or 2');
  for(let attempt=1;attempt<=attempts;attempt++){
    const started=Date.now();let failure;
    try{await run();}catch(error){failure=error;}
    const retryable=failure instanceof Error&&/Codex answer timed out/.test(failure.message);
    await onAttempt({attempt,elapsedMs:Date.now()-started,status:failure?'failed':'complete',
      failure:failure?String(failure):null,retryable:Boolean(retryable)});
    if(!failure)return;
    if(!retryable||attempt===attempts)throw failure;
  }
}
