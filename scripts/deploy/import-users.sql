-- ============================================================
-- BRR Liquor Soft — User import script
-- Run this on the production VPS after migrations have created
-- the schema tables.
--
-- Usage on VPS:
--   psql postgresql://brr:Brritsolutions2026@localhost:5433/brr_db \
--        -f /opt/brr/repo/scripts/deploy/import-users.sql
-- ============================================================

-- ── balaji_schema users ──────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS balaji_schema;

INSERT INTO balaji_schema.users
  (id, username, password, role, temp_password, must_reset_password, password_changed_at, created_at)
VALUES
  (1, 'balajiadmin',    '$2b$10$HfpRDCfdi0IfGbXV3okhduO2mksbO9ohvEjy6zgk91GXpREgXxRWy', 'admin',    NULL, false, '2026-05-16 02:44:44.139', '2026-05-16 02:44:44.141334'),
  (2, 'balajisaleman',  '$2b$10$gCOSXihMJMiYCaxH61VYjOKEMKGcINC3M2IK8dN4EpcvuvmUTqNyu', 'employee', NULL, false, '2026-05-16 02:44:44.251', '2026-05-16 02:44:44.252654'),
  (3, 'balajisaleman1', '$2b$10$ULjioKZRoLQJ/MimsCFQPu/nTRPvbMgvKm3nwupvrWyX2MJr74W0C', 'employee', NULL, false, '2026-05-16 02:44:44.351', '2026-05-16 02:44:44.352106')
ON CONFLICT (id) DO UPDATE SET
  username            = EXCLUDED.username,
  password            = EXCLUDED.password,
  role                = EXCLUDED.role,
  temp_password       = EXCLUDED.temp_password,
  must_reset_password = EXCLUDED.must_reset_password,
  password_changed_at = EXCLUDED.password_changed_at;

-- Reset sequence so next INSERT gets a safe ID
SELECT setval('balaji_schema.users_id_seq', (SELECT MAX(id) FROM balaji_schema.users));

-- ── jyothi_schema users ──────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS jyothi_schema;

INSERT INTO jyothi_schema.users
  (id, username, password, role, temp_password, must_reset_password, password_changed_at, created_at)
VALUES
  (1, 'jyothiadmin',   '$2b$10$jz5vJBlSN.rtUaT6NQd8Nuqg.rAFWWp5vqvGlnJ0FaNwocWT7shXe', 'admin',    NULL, false, '2026-06-05 14:40:44.175274', '2026-06-05 14:40:44.175274'),
  (2, 'jyothisalesman','$2b$10$ZzVIe0rpczAkG4rlUho/fudWCAFOg0MaKlr78n5agFExxnFIAwoay',  'employee', NULL, false, '2026-06-05 14:40:44.175274', '2026-06-05 14:40:44.175274')
ON CONFLICT (id) DO UPDATE SET
  username            = EXCLUDED.username,
  password            = EXCLUDED.password,
  role                = EXCLUDED.role,
  temp_password       = EXCLUDED.temp_password,
  must_reset_password = EXCLUDED.must_reset_password,
  password_changed_at = EXCLUDED.password_changed_at;

SELECT setval('jyothi_schema.users_id_seq', (SELECT MAX(id) FROM jyothi_schema.users));

-- ── Verify ───────────────────────────────────────────────────
SELECT schema_name AS schema, username, role
FROM (
  SELECT 'balaji_schema' AS schema_name, username, role FROM balaji_schema.users
  UNION ALL
  SELECT 'jyothi_schema', username, role FROM jyothi_schema.users
) t
ORDER BY schema_name, role DESC;
