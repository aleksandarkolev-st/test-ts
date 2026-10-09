import type { Snapshot } from '../state/model';
import { useEffect, useRef } from 'react';
import { command, native } from '../bridge';
export default function Answer({ snapshot: s }: { snapshot: Snapshot }) {
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    const revision = s.latency?.responseRevision ?? 0;
    const version = `${s.question?.id}:${revision}`;
    if (!s.question || !s.answer || !native() || recorded.current === version) return;
    const id = s.question.id;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      recorded.current = version;
      command('answer_visible', { id, revision }).catch(() => {});
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [s.question?.id, Boolean(s.answer), s.latency?.responseRevision]);
  return <div className="answer-content" data-question-id={s.question?.id} data-response-revision={s.latency?.responseRevision ?? 0}>
    {!!s.questions?.length && <div className="question-queue" aria-label="Question queue">{s.questions.map((q, i) => <div key={q.id}><span>Q{i + 1}</span> {q.queued ? 'queued' : q.state === 'complete' ? 'complete' : q.state === 'speculative' ? 'confirming…' : 'answering…'}<span title={q.text}> {q.text}</span></div>)}</div>}
    {s.question && <div className="question"><div className="section-label">QUESTION</div><p>{s.question.text}</p></div>}
    {s.answer && <div className="answer"><div className="section-label">SUGGESTED ANSWER</div><p aria-live="polite" aria-atomic="false">{s.answer}<span className={s.latency?.completedAt == null && s.status === 'answer' ? 'caret' : ''} /></p></div>}
    {s.status === 'thinking' && !s.answer && <div className="thinking" role="status">Finding the useful words<span>•••</span></div>}
    {s.error && <div className="error" role="alert">{s.error}</div>}
  </div>;
}
