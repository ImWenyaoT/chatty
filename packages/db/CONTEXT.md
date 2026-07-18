# Harness Store

The Harness Store preserves the evidence and state needed to complete customer-service work across turns without treating every conversation as durable customer knowledge.

## Language

**Transaction Context**:
Recent messages, confirmed facts, and open work needed for the current transaction.
_Avoid_: Long-term memory, customer profile

**Trace**:
An immutable record of what the Agent observed, selected, executed, and returned. A Trace is evidence and audit history, not automatically Memory.
_Avoid_: Memory, conversation summary

**Repeat Customer**:
A customer with at least two paid or otherwise confirmed orders.
_Avoid_: Returning visitor, second conversation

**Long-term Customer Memory**:
Source-backed durable facts or preferences retained for a Repeat Customer's future transactions. Explicit customer statements may be promoted; Model inferences remain candidates until corroborated or reviewed.
_Avoid_: Raw transcript, first-transaction context, unverified inference

**Memory Candidate**:
A source-linked proposal extracted from Trace that has not yet met the verification and eligibility rules for Long-term Customer Memory.
_Avoid_: Customer fact, promoted memory

**Knowledge Base**:
Seller-verified product and operational facts shared across customers and searched as evidence.
_Avoid_: Agent instructions, customer memory, raw conversation archive
