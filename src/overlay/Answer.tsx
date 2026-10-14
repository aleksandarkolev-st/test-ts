import type { Snapshot } from '../state/model';
import { useEffect, useRef } from 'react';
import { command, native } from '../bridge';
import { visibleAnswerRanges } from './paintedText';
import FormattedAnswer from './FormattedAnswer';
import {useKeyboardScroll} from '../useKeyboardScroll';
export default function Answer({ snapshot: s }: { snapshot: Snapshot }) {
  const recorded = useRef<string | null>(null);
  const content = useRef<HTMLDivElement>(null);
  useKeyboardScroll(()=>content.current);
  const paint = useRef({ first: 0, second: 0 });
  const acknowledged = useRef('');
  useEffect(() => () => {
    cancelAnimationFrame(paint.current.first);
    cancelAnimationFrame(paint.current.second);
    paint.current.first=0;
    paint.current.second=0;
  }, []);
  const queuePaint = () => {
    if (!native() || paint.current.first || paint.current.second) return;
    // Coalesce renders, not answer text. Restarting on every token could defer
    // the acknowledgement until the stream ends. Read the DOM at the paint.
    paint.current.first = requestAnimationFrame(() => {
      paint.current.first = 0;
      paint.current.second = requestAnimationFrame(() => {
        paint.current.second = 0;
        const element = content.current;
        const id = element?.dataset.questionId;
        const revision = Number(element?.dataset.responseRevision ?? 0);
        const body=element?.querySelector<HTMLElement>('.answer-body');
        const text=body?.dataset.rawAnswer??'';
        const ranges=body?visibleAnswerRanges(body):[];
        const version = `${id}:${revision}:${JSON.stringify(ranges)}:${text}`;
        if (!id || !text || !ranges.length || acknowledged.current === version) return;
        const paintHostMs = Date.now();
        Promise.all(ranges.map(([visibleStart,visibleEnd])=>command('answer_displayed', { id, revision, text, visibleStart, visibleEnd, paintHostMs }))).then(() => {
          acknowledged.current = version;
        }).catch(() => {});
      });
    });
  };
  useEffect(queuePaint, [s.question?.id, s.answer, s.latency?.responseRevision]);
  useEffect(() => {
    const element = content.current;
    element?.addEventListener('scroll', queuePaint, { passive: true,capture:true });
    window.addEventListener('resize', queuePaint);
    document.addEventListener('visibilitychange', queuePaint);
    return () => {
      element?.removeEventListener('scroll', queuePaint,true);
      window.removeEventListener('resize', queuePaint);
      document.removeEventListener('visibilitychange', queuePaint);
    };
  }, []);
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
  return <div ref={content} className="answer-content" data-question-id={s.question?.id} data-response-revision={s.latency?.responseRevision ?? 0}>
    {!!s.questions?.length && <div className="question-queue" aria-label="Question queue">{s.questions.map((q, i) => <div key={q.id}><span>Q{i + 1}</span> {q.queued ? 'queued' : q.state === 'complete' ? 'complete' : q.state === 'speculative' ? 'confirming…' : 'answering…'}<span title={q.text}> {q.text}</span></div>)}</div>}
    {s.question && <div className="question"><div className="section-label">QUESTION</div><p tabIndex={0} title="Scroll to read the complete question">{s.question.text}</p></div>}
    {s.answer && <div className="answer"><div className="section-label">SUGGESTED ANSWER</div><FormattedAnswer key={s.question?.id} text={s.answer}/>{s.latency?.completedAt == null && s.status === 'answer'&&<span className="caret" aria-hidden="true"/>}</div>}
    {s.status === 'thinking' && !s.answer && <div className="thinking" role="status">Finding the useful words<span>•••</span></div>}
    {s.error && <div className="error" role="alert">{s.error}</div>}
  </div>;
}
