# Synthetic interview project

An in-memory inventory reservation service. Public methods must remain synchronous and return the documented shapes. A rejected multi-item reservation must leave inventory and reservation records unchanged. Reusing an accepted request ID must return its original reservation without deducting stock again. Quantity must be a positive integer. Runtime dependencies and edits to tests are forbidden during the interview.

`src/inventory.mjs` stores inventory. `src/reservations.mjs` validates and reserves. `src/service.mjs` exports the assembled service. Run `npm test`.
