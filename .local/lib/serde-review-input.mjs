// serde_json's default map representation sorts keys recursively. Keep array
// order and exact values: source histories can contain additional public fields.
export function serializeReviewInput(value) {
 function ordered(item) {
  if (Array.isArray(item)) return item.map(ordered);
  if (item !== null && typeof item === 'object') {
   return Object.fromEntries(Object.keys(item).sort().map(key=>[key,ordered(item[key])]));
  }
  return item;
 }
 return JSON.stringify(ordered(value));
}
