import type { Snapshot } from '../state/model';
export default function Answer({ snapshot: s }: { snapshot: Snapshot }) {
  return <div className="answer-content">
    {s.question && <div className="question"><div className="section-label">QUESTION</div><p>{s.question.text}</p></div>}
    {s.answer && <div className="answer"><div className="section-label">SUGGESTED ANSWER</div><p aria-live="polite" aria-atomic="false">{s.answer}<span className={s.latency?.completedAt == null && s.status === 'answer' ? 'caret' : ''} /></p></div>}
    {s.status === 'thinking' && !s.answer && <div className="thinking" role="status">Finding the useful words<span>•••</span></div>}
    {s.error && <div className="error" role="alert">{s.error}</div>}
  </div>;
}
