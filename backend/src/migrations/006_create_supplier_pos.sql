DO $$ BEGIN
  CREATE TYPE po_status AS ENUM ('Ordered','In-Transit','Arrived','Received');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS supplier_pos (
  id            SERIAL PRIMARY KEY,
  supplier_name VARCHAR(200) NOT NULL,
  status        po_status NOT NULL DEFAULT 'Ordered',
  sku_id        INTEGER NOT NULL REFERENCES products(id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
