-- Booking Management Bot — POC schema.
-- Apply with: npm run db:setup  (or psql "$DATABASE_URL" -f db/schema.sql)
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
    ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
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
-- independent of any application-level locking: two AWAITING_PAYMENT/PENDING_CONFIRMATION/CONFIRMED
-- appointments for the same tenant+resource can never have overlapping time ranges.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, resource_id WITH =, time_range WITH &&)
  WHERE (status IN ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED'));

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

-- ---------------------------------------------------------------------------
-- Patient identity by phone number (no registration step)
-- A patient row is created automatically on a person's first message and is
-- enriched as they share details. The phone number (digits, with country code)
-- is the identity: unique per clinic.
-- ---------------------------------------------------------------------------
ALTER TABLE patients ALTER COLUMN name DROP NOT NULL;               -- we may know the number before the name
ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone_normalized text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;  -- set when the number is proven (WhatsApp sender or OTP)
ALTER TABLE patients ADD COLUMN IF NOT EXISTS name_source text CHECK (name_source IN ('whatsapp_profile', 'patient'));
ALTER TABLE patients ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS preferred_language text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS first_channel text CHECK (first_channel IN ('web', 'whatsapp'));
ALTER TABLE patients ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE patients ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

-- The name given for a specific booking (may differ from the profile, e.g. booking for a family member on a shared phone).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS patient_name text;
UPDATE appointments a SET patient_name = p.name FROM patients p WHERE a.patient_id = p.id AND a.patient_name IS NULL;

-- Backfill + merge duplicates from the earlier one-row-per-booking model (10-digit numbers assumed Indian, +91).
UPDATE patients SET phone_normalized =
  CASE WHEN length(regexp_replace(phone, '\D', '', 'g')) = 10 THEN '91' || regexp_replace(phone, '\D', '', 'g')
       ELSE regexp_replace(phone, '\D', '', 'g') END
WHERE phone_normalized IS NULL;

DO $$
BEGIN
  UPDATE appointments a SET patient_id = k.keep_id
  FROM patients p
  JOIN (SELECT tenant_id, phone_normalized, (array_agg(id ORDER BY created_at, id))[1] AS keep_id
        FROM patients GROUP BY tenant_id, phone_normalized HAVING count(*) > 1) k
    ON k.tenant_id = p.tenant_id AND k.phone_normalized = p.phone_normalized
  WHERE a.patient_id = p.id AND p.id <> k.keep_id;

  DELETE FROM patients p USING (
    SELECT tenant_id, phone_normalized, (array_agg(id ORDER BY created_at, id))[1] AS keep_id
    FROM patients GROUP BY tenant_id, phone_normalized HAVING count(*) > 1) k
  WHERE k.tenant_id = p.tenant_id AND k.phone_normalized = p.phone_normalized AND p.id <> k.keep_id;
END $$;

ALTER TABLE patients ALTER COLUMN phone_normalized SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS patients_tenant_phone_uniq ON patients (tenant_id, phone_normalized);

-- One-time codes that let a web visitor prove they own a phone number (delivered over WhatsApp).
CREATE TABLE IF NOT EXISTS phone_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  phone_normalized text NOT NULL,
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_otps_lookup_idx ON phone_otps (tenant_id, phone_normalized, created_at DESC);


-- ---------------------------------------------------------------------------
-- Payments (Razorpay). Off unless the PLATFORM admin enables it for a clinic and stores that clinic's
-- Razorpay credentials; the clinic then chooses whether to collect and sets its consultation fees.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS payments_enabled boolean NOT NULL DEFAULT false;   -- set by the platform admin only
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS razorpay_key_id text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS razorpay_key_secret_encrypted text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS razorpay_webhook_secret_encrypted text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS collect_payments boolean NOT NULL DEFAULT false;   -- clinic's switch (needs payments_enabled)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS consultation_pricing jsonb;                        -- see src/payments/pricing.ts

-- Existing databases: widen the status list and let an unpaid hold block the slot like any other booking.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK (status IN
  ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED'));
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, resource_id WITH =, time_range WITH &&)
  WHERE (status IN ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED'));

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id),
  amount_paise int NOT NULL CHECK (amount_paise > 0),
  currency text NOT NULL DEFAULT 'INR',
  band text NOT NULL,                              -- which rate applied: flat | weekday | weekend | night
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'expired', 'failed', 'cancelled')),
  razorpay_payment_link_id text UNIQUE,
  razorpay_payment_link_url text,
  razorpay_payment_id text,
  expires_at timestamptz NOT NULL,                 -- the slot hold and the payment link both lapse here
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_tenant_idx ON payments (tenant_id, status);

-- How often a bookable start time is offered (minutes). The consultant sets it in Settings; 5 means 9:00, 9:05, 9:10...
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slot_interval_minutes int NOT NULL DEFAULT 5;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_slot_interval_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_slot_interval_check CHECK (slot_interval_minutes BETWEEN 5 AND 240);
