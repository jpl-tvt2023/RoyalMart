CREATE TABLE IF NOT EXISTS products (
  id                 SERIAL PRIMARY KEY,
  sku_code           VARCHAR(60) UNIQUE NOT NULL,
  name               VARCHAR(200) NOT NULL,
  hsn_code           VARCHAR(20),
  fabric_type        VARCHAR(80),
  gsm                INTEGER,
  color              VARCHAR(60),
  safety_threshold   INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
