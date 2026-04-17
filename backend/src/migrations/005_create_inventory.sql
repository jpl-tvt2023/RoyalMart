CREATE TABLE IF NOT EXISTS inventory (
  id              SERIAL PRIMARY KEY,
  sku_id          INTEGER UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  on_hand_qty     INTEGER NOT NULL DEFAULT 0,
  in_transit_qty  INTEGER NOT NULL DEFAULT 0,
  committed_qty   INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
