-- Migration 0006: materials catalogue and stock schema

-- Trigram extension for fuzzy/substring search (rule 152)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Materials table
CREATE TABLE IF NOT EXISTS materials (
  id         BIGSERIAL   PRIMARY KEY,
  name       TEXT        NOT NULL,
  category   TEXT        NOT NULL,
  unit       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive unique material name
CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_name_unique
ON materials (lower(name));

-- Trigram GIN index on material name for fast search at scale (context.md rule 152)
CREATE INDEX IF NOT EXISTS idx_materials_name_trgm
ON materials USING gin (name gin_trgm_ops);

-- Category index for filtering
CREATE INDEX IF NOT EXISTS idx_materials_category
ON materials (category);

-- Stock table: stores stock for company store and project stores (rule 120-122)
CREATE TABLE IF NOT EXISTS stock (
  store_id         BIGINT        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  material_id      BIGINT        NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
  quantity         NUMERIC(14,3) NOT NULL DEFAULT 0.000 CHECK (quantity >= 0),
  reorder_point    NUMERIC(14,3) NOT NULL DEFAULT 0.000 CHECK (reorder_point >= 0),
  last_delivery_at TIMESTAMPTZ,
  status           TEXT          GENERATED ALWAYS AS (
    CASE
      WHEN quantity = 0 THEN 'out_of_stock'
      WHEN quantity > 0 AND quantity <= reorder_point THEN 'low_stock'
      ELSE 'available'
    END
  ) STORED,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, material_id)
);

-- Index for stock queries by material
CREATE INDEX IF NOT EXISTS idx_stock_material_id
ON stock (material_id);

-- Index for status filtering on stock
CREATE INDEX IF NOT EXISTS idx_stock_status
ON stock (status);
