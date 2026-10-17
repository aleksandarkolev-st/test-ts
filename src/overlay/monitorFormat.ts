import type { MonitorStatus } from '../state/model';
export function monitorLabel(m: MonitorStatus): string {
  if (m.typed) return 'Answer typed into the field';
  if (m.warning) return m.warning;
  if (m.state === 'error') return 'Screen monitor needs attention';
  if (m.state === 'analyzing') return 'Reading the screen…';
  if (m.focus) return 'Focused field watched';
  if (m.answerCached) return 'Answer ready for the field';
  if (m.question) return 'Question found';
  return 'Watching authorized apps';
}
export function monitorTone(m: MonitorStatus): 'done' | 'warn' | 'busy' | 'idle' {
  if (m.typed) return 'done';
  if (m.warning || m.state === 'error') return 'warn';
  if (m.state === 'analyzing' || m.focus || m.answerCached) return 'busy';
  return 'idle';
}
export function monitorTitle(m: MonitorStatus): string {
  const parts: string[] = [];
  if (m.question) parts.push(`Question: ${m.question}`);
  if (m.executable) parts.push(`Watched app: ${m.executable}`);
  parts.push(`${m.analyzedFrames} frames analyzed · ${m.solutions} answers prepared`);
  if (m.warning) parts.push(m.warning);
  parts.push('Typing is automated keyboard input sent through your keyboard\'s screen-typing firmware. It starts only after you focus the answer field, and Ctrl Shift F12 stops it.');
  return parts.join('\n');
}
