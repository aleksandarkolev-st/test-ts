export class Inventory {
  constructor(stock) { this.stock = new Map(Object.entries(stock)); }
  available(sku) { return this.stock.get(sku) ?? 0; }
  take(sku, quantity) {
    if (this.available(sku) < quantity) throw new Error('insufficient stock');
    this.stock.set(sku, this.available(sku) - quantity);
  }
  snapshot() { return Object.fromEntries(this.stock); }
}
