-- Migration 0009: deliveries and delivery_lines schema (rule 125-134)

CREATE TABLE IF NOT EXISTS deliveries (
  id               BIGSERIAL   PRIMARY KEY,
  project_id       BIGINT      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  direction        TEXT        NOT NULL CHECK (direction IN ('to_project', 'to_company')),
  status           TEXT        NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'delivered', 'rejected', 'cancelled')),
  sender_user_id   BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  receiver_user_id BIGINT      REFERENCES users(id) ON DELETE RESTRICT,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_lines (
  delivery_id BIGINT        NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  material_id BIGINT        NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
  quantity    NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_id, material_id)
);

-- Partial index for "in-transit to projects" on company stock screen (rule 134)
CREATE INDEX IF NOT EXISTS idx_deliveries_in_transit_to_project
ON deliveries (id)
WHERE direction = 'to_project' AND status = 'in_transit';

-- Indexes for delivery lines
CREATE INDEX IF NOT EXISTS idx_delivery_lines_material_delivery
ON delivery_lines (material_id, delivery_id);

-- Keyset pagination indexes (rule 152) and query filters
CREATE INDEX IF NOT EXISTS idx_deliveries_project_created_id
ON deliveries (project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_deliveries_created_id
ON deliveries (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_deliveries_project_direction
ON deliveries (project_id, direction);

CREATE INDEX IF NOT EXISTS idx_deliveries_project_status
ON deliveries (project_id, status);

CREATE INDEX IF NOT EXISTS idx_deliveries_status
ON deliveries (status);

CREATE INDEX IF NOT EXISTS idx_deliveries_direction
ON deliveries (direction);
