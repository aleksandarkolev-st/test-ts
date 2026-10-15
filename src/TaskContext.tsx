import { useEffect, useRef, useState } from 'react';
import { command, errorText } from './bridge';
import type { Snapshot } from './state/model';

export default function TaskContext({ snapshot, onError }: { snapshot: Snapshot; onError: (error: string) => void }) {
  if (!snapshot.active) return null;
  return <TaskEditor key={snapshot.task.id} snapshot={snapshot} onError={onError} />;
}

function TaskEditor({ snapshot, onError }: { snapshot: Snapshot; onError: (error: string) => void }) {
  const { task } = snapshot;
  const [problem, setProblem] = useState(task.problem);
  const [output, setOutput] = useState(task.testOutput?.text || '');
  const [saving, setSaving] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => setProblem(task.problem), [task.problem]);
  useEffect(() => setOutput(task.testOutput?.text || ''), [task.testOutput?.text]);
  async function save(field: 'problem' | 'test_output', text: string) {
    setSaving(field); onError('');
    try { await command('update_task', { taskId: task.id, field, text }); }
    catch (error) { if (mounted.current) onError(errorText(error)); }
    finally { if (mounted.current) setSaving(''); }
  }
  return <section className="task-context" aria-label="Current interview task">
    <div className="task-heading"><strong>Interview task</strong><button title="Clear this problem, its context and answers; keep the meeting running" onClick={() => command('action', { action: 'new_task' }).then(() => onError('')).catch(e => onError(errorText(e)))}>New task</button></div>
    {task.problem && <p className="task-problem" title={task.problem}>{task.problem}</p>}
    <details><summary>Problem statement &amp; test output</summary>
      <p>Save the problem once. Refresh code and test output as you work.</p>
      <form onSubmit={event => { event.preventDefault(); void save('problem', problem); }}>
        <label htmlFor="task-problem">Problem statement</label><textarea id="task-problem" value={problem} maxLength={12000} rows={4} onChange={event => setProblem(event.target.value)} placeholder="Paste the problem, requirements and constraints" />
        <div className="task-buttons"><button disabled={!!saving || problem === task.problem}>{saving === 'problem' ? 'Savingâ€¦' : 'Save problem'}</button><button type="button" disabled={!!saving || !snapshot.question} onClick={() => { const text = snapshot.question?.text; if (text) { setProblem(text); void save('problem', text); } }}>Use current question</button></div>
      </form>
      <form onSubmit={event => { event.preventDefault(); void save('test_output', output); }}>
        <label htmlFor="task-test-output">Test output</label><textarea id="task-test-output" value={output} maxLength={24000} rows={4} onChange={event => setOutput(event.target.value)} placeholder="Paste the latest failing tests, compiler error or terminal output" />
        <div className="task-buttons"><button disabled={!!saving || output === (task.testOutput?.text || '')}>{saving === 'test_output' ? 'Updatingâ€¦' : 'Update test output'}</button>{task.testOutput && <button type="button" disabled={!!saving} onClick={() => void save('test_output', '')}>Remove test output</button>}</div>
      </form>
    </details>
  </section>;
}
