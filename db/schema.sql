-- Booking Management Bot — POC schema.
-- Apply once with: psql "$DATABASE_URL" -f db/schema.sql
-- No migration framework here (POC scope) — before production, replace this
-- with real versioned migrations (e.g. node-pg-migrate).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- required for EXCLUDE USING gist on uuid + range

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  timezone text NOT NULL,
  confirmation_policy text NOT NULL DEFAULT 'staff_approval'
    CHECK (confirmation_policy IN ('instant', 'staff_approval')),
  whatsapp_phone_number_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  duration_minutes int NOT NULL CHECK (duration_minutes > 0),
  buffer_minutes int NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  google_calendar_id text,
  google_refresh_token_encrypted text,
  google_connection_status text NOT NULL DEFAULT 'disconnected'
    CHECK (google_connection_status IN ('disconnected', 'connected', 'error')),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  resource_id uuid NOT NULL REFERENCES resources(id),
  weekday smallint CHECK (weekday BETWEEN 0 AND 6),
  specific_date date,
  start_time time,
  end_time time,
  is_closed boolean NOT NULL DEFAULT false,
  CHECK (
    (weekday IS NOT NULL AND specific_date IS NULL) OR
    (weekday IS NULL AND specific_date IS NOT NULL)
  ),
  CHECK (is_closed OR (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time))
);
CREATE INDEX IF NOT EXISTS availability_rules_resource_idx ON availability_rules (tenant_id, resource_id);

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  phone text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS patients_phone_idx ON patients (tenant_id, phone);

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  service_id uuid NOT NULL REFERENCES services(id),
  resource_id uuid NOT NULL REFERENCES resources(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN
    ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
  channel text NOT NULL CHECK (channel IN ('web', 'whatsapp')),
  idempotency_key text NOT NULL,
  cancel_reason text,
  rejected_reason text,
  google_event_id text,
  calendar_sync_status text NOT NULL DEFAULT 'pending'
    CHECK (calendar_sync_status IN ('pending', 'synced', 'failed', 'skipped')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  time_range tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  UNIQUE (tenant_id, idempotency_key),
  CHECK (start_at < end_at)
);

-- The invariant that makes double-booking impossible at the database level,
-- independent of any application-level locking: two PENDING_CONFIRMATION/CONFIRMED
-- appointments for the same tenant+resource can never have overlapping time ranges.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, resource_id WITH =, time_range WITH &&)
  WHERE (status IN ('PENDING_CONFIRMATION', 'CONFIRMED'));

CREATE INDEX IF NOT EXISTS appointments_tenant_status_idx ON appointments (tenant_id, status);

-- Shared conversation state for both chat channels (web widget + WhatsApp).
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'web')),
  external_id text NOT NULL,
  state jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, external_id)
);

-- ---------------------------------------------------------------------------
-- Agent / notification additions (idempotent, safe to re-apply)
-- ---------------------------------------------------------------------------

-- confirmation_policy is the clinic's choice of booking flow:
--   'instant'        -> direct booking: only free calendar time is offered, booking confirms and blocks the calendar
--   'staff_approval' -> the doctor must explicitly accept (APPROVE <ref> on WhatsApp or the dashboard)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS staff_whatsapp_number text;           -- digits only, with country code
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reminder_hours_before int NOT NULL DEFAULT 24 CHECK (reminder_hours_before >= 0); -- 0 = off
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS faq_text text;                        -- clinic FAQs the agent may answer from

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS calendar_synced_at timestamptz;     -- watermark for polling doctor-side calendar edits

-- WhatsApp redelivers webhooks; remember message ids so each is handled once.
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
