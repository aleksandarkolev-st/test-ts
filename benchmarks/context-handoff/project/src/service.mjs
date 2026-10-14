import { Inventory } from './inventory.mjs';
import { Reservations } from './reservations.mjs';
export function createService(stock) {
  const inventory = new Inventory(stock);
  const reservations = new Reservations(inventory);
  return {reserve: (id, items) => reservations.reserve(id, items), inventory: () => inventory.snapshot()};
}
