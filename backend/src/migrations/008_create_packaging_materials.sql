CREATE TABLE IF NOT EXISTS packaging_materials (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(200) NOT NULL,
  unit              VARCHAR(30) NOT NULL DEFAULT 'pcs',
  on_hand_qty       INTEGER NOT NULL DEFAULT 0,
  safety_threshold  INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
