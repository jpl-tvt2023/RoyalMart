-- Stage handoffs: one row per lot moved from one processing stage to the next.
--
-- WHAT IS NOT HERE. Origin lots -- material bought at some stage and received
-- against an outbound PO -- are NOT copied into this table. They stay as
-- outbound_po_line_receipts rows and the Stitching page reads them directly,
-- UNION ALLed with this table. Materialising a copy would mean keeping two
-- tables in step across six receipt write paths, which is precisely the silent
-- drift outboundPOFlags.js documents avoiding. So this table holds only the
-- downstream rows, and every row has exactly one parent -- either the receipt it
-- came from (first hop) or another entry (later hops).
--
-- sent_qty vs metre. Fabric shrinks. sent_qty is what left the parent lot and is
-- what the parent's remaining balance is reduced by. metre is what actually came
-- back at this stage. The difference is process loss, and collapsing them into
-- one number would make loss indistinguishable from material still in hand.
--
-- origin_receipt_id is denormalised onto every row, copied from the parent and
-- never changed. It buys the article name, unit metric, PO and vendor in one
-- plain JOIN instead of a recursive walk up a chain. The chain is at most four
-- deep, so this is about query simplicity rather than performance.
--
-- There is deliberately NO rate column. The rate carried into a stage is always
-- the parent's after_rate, resolved with a single-hop LEFT JOIN at read time, so
-- correcting a rate upstream flows down the chain instead of stranding a stale
-- copy. Same reasoning as outbound_po_lines.received being a correlated SUM.
--
-- party_name is free text, not a FK. The processing houses are not necessarily
-- outbound vendors, and the user has said a party master may come later -- when
-- it does, add party_id and backfill against this column. The form offers a
-- datalist of known names so the free text stays tidy in the meantime.
--
-- status is NOT stored. It is derived from metre minus the sum of live children's
-- sent_qty, exactly as outbound PO line status is derived from qty/received/short.
CREATE TABLE IF NOT EXISTS stitching_entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stage              TEXT NOT NULL CHECK (stage IN ('Gray','Processed','Stitched','Packed')),
  origin_receipt_id  INTEGER NOT NULL REFERENCES outbound_po_line_receipts(id),
  parent_receipt_id  INTEGER REFERENCES outbound_po_line_receipts(id),
  parent_entry_id    INTEGER REFERENCES stitching_entries(id),
  party_name         TEXT NOT NULL,
  bill_no            TEXT,
  challan_no         TEXT,
  incoming_prefix_id INTEGER REFERENCES stitching_prefixes(id),
  incoming_no        TEXT,
  sent_qty           REAL NOT NULL,
  metre              REAL NOT NULL,
  process_rate       REAL,
  after_rate         REAL,
  checked_by         INTEGER REFERENCES users(id),
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by         INTEGER REFERENCES users(id),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by         INTEGER REFERENCES users(id),
  deleted_at         TEXT,
  CHECK ((parent_receipt_id IS NULL) <> (parent_entry_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_stitching_entries_parent_receipt ON stitching_entries(parent_receipt_id);

CREATE INDEX IF NOT EXISTS idx_stitching_entries_parent_entry ON stitching_entries(parent_entry_id);

CREATE INDEX IF NOT EXISTS idx_stitching_entries_origin ON stitching_entries(origin_receipt_id);

CREATE INDEX IF NOT EXISTS idx_stitching_entries_stage ON stitching_entries(stage)
