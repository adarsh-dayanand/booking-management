-- Demo data for local development. Safe to re-run (guards against duplicate inserts).
-- Apply with: psql "$DATABASE_URL" -f db/seed.sql
--
-- Creates: one tenant ("demo-clinic"), one staff login, one service, one
-- practitioner resource (Mon-Fri 09:00-17:00), and one staff login you can
-- use against POST /v1/admin/login:
--   email:    owner@demo-clinic.test
--   password: password123

INSERT INTO tenants (name, slug, timezone, confirmation_policy)
SELECT 'Demo Clinic Bengaluru', 'demo-clinic', 'Asia/Kolkata', 'staff_approval'
WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE slug = 'demo-clinic');

INSERT INTO staff_users (tenant_id, email, password_hash)
SELECT t.id, 'owner@demo-clinic.test', crypt('password123', gen_salt('bf'))
FROM tenants t
WHERE t.slug = 'demo-clinic'
  AND NOT EXISTS (
    SELECT 1 FROM staff_users s WHERE s.tenant_id = t.id AND s.email = 'owner@demo-clinic.test'
  );

INSERT INTO services (tenant_id, name, duration_minutes, buffer_minutes)
SELECT t.id, 'General Consultation', 30, 5
FROM tenants t
WHERE t.slug = 'demo-clinic'
  AND NOT EXISTS (
    SELECT 1 FROM services sv WHERE sv.tenant_id = t.id AND sv.name = 'General Consultation'
  );

INSERT INTO resources (tenant_id, name)
SELECT t.id, 'Dr. Demo Practitioner'
FROM tenants t
WHERE t.slug = 'demo-clinic'
  AND NOT EXISTS (
    SELECT 1 FROM resources r WHERE r.tenant_id = t.id AND r.name = 'Dr. Demo Practitioner'
  );

-- Monday(1) through Friday(5), 09:00-17:00. (weekday: 0=Sunday .. 6=Saturday)
INSERT INTO availability_rules (tenant_id, resource_id, weekday, start_time, end_time, is_closed)
SELECT t.id, r.id, wd, '09:00', '17:00', false
FROM tenants t
JOIN resources r ON r.tenant_id = t.id AND r.name = 'Dr. Demo Practitioner'
CROSS JOIN generate_series(1, 5) AS wd
WHERE t.slug = 'demo-clinic'
  AND NOT EXISTS (
    SELECT 1 FROM availability_rules ar
    WHERE ar.tenant_id = t.id AND ar.resource_id = r.id AND ar.weekday = wd
  );
