import type { Snapshot } from '../state/model';
import { useEffect, useRef } from 'react';
import { command, native } from '../bridge';
export default function Answer({ snapshot: s }: { snapshot: Snapshot }) {
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (!s.question || !s.answer || !native() || recorded.current === s.question.id) return;
    const id = s.question.id;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      recorded.current = id;
      command('answer_visible', { id }).catch(() => {});
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [s.question?.id, Boolean(s.answer)]);
  return <div className="answer-content">
    {!!s.questions?.length && <div className="question-queue" aria-label="Question queue">{s.questions.map((q, i) => <div key={q.id}><span>Q{i + 1}</span> {q.queued ? 'queued' : q.state === 'complete' ? 'complete' : q.state === 'speculative' ? 'confirming…' : 'answering…'}<span title={q.text}> {q.text}</span></div>)}</div>}
    {s.question && <div className="question"><div className="section-label">QUESTION</div><p>{s.question.text}</p></div>}
    {s.answer && <div className="answer"><div className="section-label">SUGGESTED ANSWER</div><p aria-live="polite" aria-atomic="false">{s.answer}<span className={s.latency?.completedAt == null && s.status === 'answer' ? 'caret' : ''} /></p></div>}
    {s.status === 'thinking' && !s.answer && <div className="thinking" role="status">Finding the useful words<span>•••</span></div>}
    {s.error && <div className="error" role="alert">{s.error}</div>}
  </div>;
}
