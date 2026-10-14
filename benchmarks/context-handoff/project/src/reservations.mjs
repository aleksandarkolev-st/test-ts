export class Reservations {
  constructor(inventory) { this.inventory = inventory; this.requests = new Map(); }
  reserve(requestId, items) {
    if (this.requests.has(requestId)) return this.requests.get(requestId);
    for (const {sku, quantity} of items) {
      if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('invalid quantity');
      this.inventory.take(sku, quantity);
    }
    const result = {requestId, items: items.map(item => ({...item})), status: 'accepted'};
    this.requests.set(requestId, result);
    return result;
  }
}
