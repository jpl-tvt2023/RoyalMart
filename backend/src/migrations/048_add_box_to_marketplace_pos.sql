-- Box count for a dispatched order. Additive and nullable at the DB level —
-- mandatory-when-Closed validation is enforced in the application layer
-- (orderSummary.controller.js), mirroring how tracking_id has no DB-level CHECK.

ALTER TABLE marketplace_pos ADD COLUMN box INTEGER;
