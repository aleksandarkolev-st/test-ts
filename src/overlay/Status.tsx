import type { Snapshot } from '../state/model';
export default function Status({ snapshot: s }: { snapshot: Snapshot }) {
  const label = s.paused ? 'Paused' : { off: 'Off', loading: 'Loading local speech…', listening: 'Listening', question: 'Question detected', thinking: 'Thinking…', answer: 'Suggested answer', error: 'Needs attention' }[s.status];
  return <div className={`status status-${s.status}`}><i aria-hidden="true" />{label}</div>;
}
