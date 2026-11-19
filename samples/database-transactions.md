# Database transactions

A transaction is a sequence of operations performed as a single logical unit of work. Either every operation in the transaction is applied, or none of them is applied at all.

## ACID properties

**Atomicity** guarantees that all operations in the transaction complete successfully or the transaction is rolled back entirely.

**Consistency** means the database moves from one valid state to another valid state, so every transaction respects the declared constraints.

**Isolation** determines how the effects of concurrent transactions interleave. At the serialisable level, the outcome is the same as if the transactions had run one after another, which is the strongest guarantee.

**Durability** states that once a transaction commits, its effects survive a crash.

## Isolation levels

The read uncommitted level permits dirty reads. Read committed prevents dirty reads but allows non-repeatable reads. Repeatable read prevents a row read twice from changing, and serialisable prevents phantom rows from appearing.

Every isolation level trades some concurrency for correctness. Choose the weakest level that keeps the application correct.
