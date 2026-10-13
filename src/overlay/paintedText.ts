// Fully visible source characters, in browser UTF-16 coordinates. Keeping
// viewport evidence separate avoids calling clipped output an already seen cue.
export function visibleAnswerRange(p: HTMLParagraphElement): [number, number] {
  const text = p.firstChild;
  const style = getComputedStyle(p);
  if (document.visibilityState !== 'visible' || style.visibility === 'hidden' || style.display === 'none' || text?.nodeType !== Node.TEXT_NODE) return [0, 0];
  const value = text.textContent ?? '';
  const clip = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
  for (let parent = p.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent), rect = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(css.overflowY)) { clip.top = Math.max(clip.top, rect.top); clip.bottom = Math.min(clip.bottom, rect.bottom); }
    if (/auto|scroll|hidden|clip/.test(css.overflowX)) { clip.left = Math.max(clip.left, rect.left); clip.right = Math.min(clip.right, rect.right); }
  }
  const rect = p.getBoundingClientRect();
  if (!value || rect.width <= 0 || clip.bottom <= clip.top || rect.right <= clip.left || rect.left >= clip.right) return [0, 0];
  const boundary = (predicate: (r: DOMRect) => boolean) => {
    let low = 0, high = value.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2), range = document.createRange();
      range.setStart(text, middle); range.setEnd(text, middle + 1);
      if (predicate(range.getBoundingClientRect())) high = middle; else low = middle + 1;
    }
    return low;
  };
  let start = boundary(r => r.top >= clip.top), end = boundary(r => r.bottom > clip.bottom);
  // Never split a surrogate pair at a viewport boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(value[start] ?? '')) start++;
  if (end > 0 && /[\uDC00-\uDFFF]/.test(value[end] ?? '')) end--;
  return start < end ? [start, end] : [0, 0];
}
