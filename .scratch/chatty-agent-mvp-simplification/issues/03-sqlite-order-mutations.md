# 03 — SQLite Order Mutations

**What to build:** After the Model resolves rental versus buyout and required fields, Chatty creates, confirms, or cancels a conventional simplified order through idempotent SQLite transactions that affect later availability.

**Blocked by:** 02 — SQLite-backed Availability.

**Status:** done

Completed with transactional rental/buyout orders, overlap accounting, cancellation, rollback, and idempotency tests.

- [ ] Rental and buyout are explicit Fulfillment Modes; ambiguity requests customer information before a write.
- [ ] Order creation returns a stored order identifier and status that can be read back.
- [ ] Confirmed rental dates reduce overlapping availability but not non-overlapping availability.
- [ ] Confirmed buyout permanently reduces quantity in later checks.
- [ ] Cancellation releases the appropriate allocation.
- [ ] Duplicate idempotency keys do not duplicate orders or oversell inventory.
- [ ] Failed transactions leave order and inventory state unchanged.
