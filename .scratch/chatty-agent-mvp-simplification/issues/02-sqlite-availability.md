# 02 — SQLite-backed Availability

**What to build:** A customer asking whether a product and size are available receives an answer from real SQLite Demo Business Data, and the structured tool receipt is preserved in Trace.

**Blocked by:** None — can start immediately.

**Status:** done

Completed through the SQLite Commerce Repository, bounded tool adapter, Trace, and persisted-turn tests.

- [ ] SQLite contains synthetic or anonymized products, variants, and quantity seed data.
- [ ] Availability is queried by trusted product identity, size, quantity, Fulfillment Mode, and rental dates when relevant.
- [ ] Different stored products, sizes, quantities, and overlapping dates produce different verifiable results.
- [ ] Unknown products and insufficient quantity return explicit failures rather than simulated success.
- [ ] The Model still chooses the availability tool; the Harness injects trusted identifiers and validates its receipt.
- [ ] The public Harness and persisted customer-turn seams prove the result and Trace against a disposable SQLite database.
