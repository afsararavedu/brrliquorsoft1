# Hostinger KVM 2 VPS + Supabase — Deployment Runbook

This document is the step-by-step operator runbook for deploying BRR Liquor Soft
on Hostinger KVM 2 VPS with Supabase as the PostgreSQL database.

---

## Prerequisites

- Hostinger KVM 2 VPS provisioned (Ubuntu 22.04 or 24.04 recommended)
- Supabase project created at https://supabase.com
- SSH access to your VPS
- Your AWS RDS still running (for the data migration)

---

## Step 1 — Supabase Setup

### 1.1 Create Supabase Project

1. Go to https://supabase.com → **New Project**
2. Region: **South Asia (ap-south-1)** for lowest latency from India
3. Save the database password securely
4. Wait ~2 minutes for provisioning

### 1.2 Create Tenant Schemas

Go to **Supabase Dashboard → SQL Editor → New Query** and run:

```
scripts/deploy/supabase-setup.sql
```

(Copy-paste the file contents into the editor and click Run.)

### 1.3 Get Your Connection Strings

Go to **Supabase Dashboard → Project Settings → Database → Connection string**

You need **two** URLs:

| Purpose | Mode | Port | Use for |
|---|---|---|---|
| `DATABASE_URL` | Transaction (PgBouncer) | **6543** | API server runtime queries |
| `DIRECT_DATABASE_URL` | Direct connection | **5432** | Schema bootstrap DDL only |

Both are in the "Connection string" section — switch the tab between "Transaction" and "Session/Direct".

**Add `?pgbouncer=true` to the Transaction URL** (port 6543):
```
postgresql://postgres.[ref]:[pass]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true
```

---

## Step 2 — Migrate Data from RDS to Supabase

Run these commands on your existing AWS EC2, or from any machine that can reach both RDS and Supabase.

### 2.1 Export each schema from RDS

```bash
RDS_URL="postgres://brr:YOURPASS@brr-db.xxxxxx.ap-south-2.rds.amazonaws.com:5432/postgres"

for schema in balaji_schema jyothi_schema padma_schema shop4_schema; do
  pg_dump "$RDS_URL" \
    --schema=$schema \
    --no-owner \
    --no-acl \
    -Fc \
    -f ${schema}.dump
  echo "Exported $schema"
done
```

### 2.2 Import into Supabase

```bash
SUPABASE_DIRECT="postgresql://postgres.[ref]:[pass]@db.[ref].supabase.co:5432/postgres"

for schema in balaji_schema jyothi_schema padma_schema shop4_schema; do
  pg_restore \
    --dbname="$SUPABASE_DIRECT" \
    --schema=$schema \
    --no-owner \
    --no-acl \
    ${schema}.dump
  echo "Imported $schema"
done
```

### 2.3 Verify Row Counts

Run in **Supabase SQL Editor**:

```sql
SELECT schemaname, tablename, n_live_tup AS row_count
FROM pg_stat_user_tables
WHERE schemaname IN ('balaji_schema','jyothi_schema','padma_schema','shop4_schema')
ORDER BY schemaname, tablename;
```

Compare with the same query run on RDS to confirm counts match.

---

## Step 3 — Hostinger VPS Setup

SSH into your VPS as root:

```bash
ssh root@YOUR_VPS_IP
```

### 3.1 System Setup

```bash
apt update && apt upgrade -y
apt install -y git nginx curl build-essential

# Node.js 24 LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# pnpm
corepack enable
corepack prepare pnpm@latest --activate

# Verify
node --version   # v24.x.x
pnpm --version   # 10.x.x
```

### 3.2 Create App User

```bash
useradd -m -s /bin/bash brr
mkdir -p /opt/brr
chown brr:brr /opt/brr
```

### 3.3 Clone and Build

```bash
su - brr
cd /opt/brr
git clone https://github.com/afsararavedu/afs_replit_repository.git repo
cd repo
bash scripts/deploy/build-release.sh
exit  # back to root
```

### 3.4 Create Environment File

```bash
mkdir -p /etc/brr
cp /opt/brr/repo/deploy/hostinger/brr-api.env.example /etc/brr/brr-api.env
nano /etc/brr/brr-api.env   # fill in your Supabase URLs and secrets
chown root:root /etc/brr/brr-api.env
chmod 600 /etc/brr/brr-api.env
```

### 3.5 Install systemd Service

```bash
cp /opt/brr/repo/deploy/hostinger/brr-api.service.example \
   /etc/systemd/system/brr-api.service

systemctl daemon-reload
systemctl enable brr-api
systemctl start brr-api
systemctl status brr-api
```

Check logs:

```bash
journalctl -u brr-api -f
```

Expected output on first boot:
```
[db] Schema "balaji_schema" is ready.
[db] Migrations applied from .../migrations
Server listening { port: 8080 }
```

### 3.6 Install Nginx

```bash
mkdir -p /var/www/brr-web
cp -R /opt/brr/repo/release/web/. /var/www/brr-web/
chown -R www-data:www-data /var/www/brr-web

cp /opt/brr/repo/deploy/hostinger/nginx.conf.example \
   /etc/nginx/conf.d/brr.conf

nginx -t
systemctl enable nginx
systemctl restart nginx
```

---

## Step 4 — Multi-Tenant Setup (Multiple Shops)

If you need each shop on its own subdomain with its own data isolation:

```bash
# Create env file per shop
cp /etc/brr/brr-api.env /etc/brr/brr-api-balaji.env
cp /etc/brr/brr-api.env /etc/brr/brr-api-jyothi.env

# Edit each: change PORT and DB_SCHEMA
nano /etc/brr/brr-api-balaji.env   # PORT=8080, DB_SCHEMA=balaji_schema
nano /etc/brr/brr-api-jyothi.env   # PORT=8081, DB_SCHEMA=jyothi_schema

# Create service per shop
cp /etc/systemd/system/brr-api.service /etc/systemd/system/brr-api-balaji.service
cp /etc/systemd/system/brr-api.service /etc/systemd/system/brr-api-jyothi.service

# Edit each service: change EnvironmentFile=
nano /etc/systemd/system/brr-api-balaji.service
nano /etc/systemd/system/brr-api-jyothi.service

systemctl daemon-reload
systemctl enable --now brr-api-balaji brr-api-jyothi
```

Then uncomment the multi-tenant blocks in `nginx.conf.example` and reload Nginx.

---

## Step 5 — Ongoing Deployments

```bash
su - brr
cd /opt/brr/repo
git pull origin main
bash scripts/deploy/build-release.sh
exit

# Copy new web build
cp -R /opt/brr/repo/release/web/. /var/www/brr-web/

# Restart API (Drizzle auto-migration runs on startup)
systemctl restart brr-api
journalctl -u brr-api -f   # watch for migration success
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `prepared statement "s0" already exists` | Missing `?pgbouncer=true` on DATABASE_URL | Append `?pgbouncer=true` to your Transaction Pooler URL |
| `401` on every request after login | `session` table missing | Check logs for schema errors; ensure DIRECT_DATABASE_URL is set |
| `502 Bad Gateway` | API not running | `systemctl status brr-api` + `journalctl -u brr-api -n 50` |
| CORS errors in browser | Domain not in CORS_ORIGIN | Set `CORS_ORIGIN=http://yourdomain.com` in `/etc/brr/brr-api.env` |
| `ECONNREFUSED` to Supabase | VPS firewall blocking port 6543 | `ufw allow out 6543` or check Hostinger VPS firewall in hPanel |
| Schema not found | Schema not pre-created | Run `scripts/deploy/supabase-setup.sql` in Supabase SQL Editor |
