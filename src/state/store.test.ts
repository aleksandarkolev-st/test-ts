import { describe, it, expect, beforeEach } from 'vitest';
import { useMeeting } from './store';
import { initialSnapshot } from './model';
describe('meeting state from native events', () => {
  beforeEach(() => useMeeting.setState({ snapshot: initialSnapshot }));
  it('rejects old bootstrap responses after new stream events', () => {
    useMeeting.getState().apply({ ...initialSnapshot, revision: 10, active: true, status: 'answer', answer: 'October ' });
    useMeeting.getState().apply({ ...initialSnapshot, revision: 9 });
    expect(useMeeting.getState().snapshot.answer).toBe('October ');
  });
  it('clears answer and question when the native session stops', () => {
    useMeeting.getState().apply({ ...initialSnapshot, revision: 1, active: true, answer: 'Private text', question: { id: 'q', text: 'Private question', detectedAt: 1 } });
    useMeeting.getState().apply({ ...initialSnapshot, revision: 2 });
    expect(useMeeting.getState().snapshot.answer).toBe('');
    expect(useMeeting.getState().snapshot.question).toBeNull();
  });
});
