# Hostinger KVM 2 VPS + Local PostgreSQL — Deployment Runbook

Self-hosted deployment of BRR Liquor Soft on a Hostinger KVM 2 VPS using
PostgreSQL installed directly on the same server. No external database service
(Supabase / RDS) required.

---

## Prerequisites

- Hostinger KVM 2 VPS provisioned (Ubuntu 22.04 or 24.04 recommended)
- SSH access to your VPS as root
- A domain name pointed at your VPS IP (or use the bare IP for testing)

---

## Step 1 — System Setup

SSH into your VPS as root:

```bash
ssh root@YOUR_VPS_IP
```

Install system packages:

```bash
apt update && apt upgrade -y
apt install -y git nginx curl build-essential postgresql postgresql-contrib

# Node.js 24 LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# pnpm
corepack enable
corepack prepare pnpm@latest --activate

# Verify
node --version       # v24.x.x
pnpm --version       # 10.x.x
psql --version       # psql 14.x or 16.x
```

---

## Step 2 — Configure PostgreSQL

```bash
# Start and enable PostgreSQL
systemctl enable --now postgresql

# Open a psql shell as the postgres superuser
sudo -u postgres psql
```

Inside psql, run:

```sql
-- Create a dedicated DB user for the app
CREATE USER brr WITH PASSWORD 'CHOOSE_A_STRONG_PASSWORD';

-- Create the database
CREATE DATABASE brr_db OWNER brr;

-- Grant full access
GRANT ALL PRIVILEGES ON DATABASE brr_db TO brr;

-- Exit psql
\q
```

Test the connection:

```bash
psql postgresql://brr:CHOOSE_A_STRONG_PASSWORD@localhost:5432/brr_db -c "SELECT version();"
```

You should see the PostgreSQL version string. If it fails, check that PostgreSQL
is listening on localhost:

```bash
ss -tlnp | grep 5432
```

---

## Step 3 — Create App User and Directory

```bash
useradd -m -s /bin/bash brr
mkdir -p /opt/brr
chown brr:brr /opt/brr
```

---

## Step 4 — Clone and Build

```bash
su - brr
cd /opt/brr
git clone https://github.com/afsararavedu/afs_replit_repository.git repo
cd repo
bash scripts/deploy/build-release.sh
exit  # back to root
```

The build script produces:

```
release/
  api/        ← Node.js api-server bundle + runtime dependencies
  web/        ← Static Vite build to serve from nginx
  VERSION     ← git SHA + build timestamp
brr-liquor-soft-release.tar.gz   ← same contents, packaged for transfer
```

---

## Step 5 — Create Environment File

```bash
mkdir -p /etc/brr
cp /opt/brr/repo/deploy/hostinger/brr-api.env.local-pg.example /etc/brr/brr-api.env
nano /etc/brr/brr-api.env
```

Fill in these values:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://brr:CHOOSE_A_STRONG_PASSWORD@localhost:5432/brr_db` |
| `SESSION_SECRET` | Run `openssl rand -hex 32` and paste the output |
| `DB_SCHEMA` | Leave as `balaji_schema` (first shop) |
| `NODE_ENV` | `http` (change to `production` only after adding HTTPS) |

Lock down the file:

```bash
chown root:root /etc/brr/brr-api.env
chmod 600 /etc/brr/brr-api.env
```

---

## Step 6 — Install systemd Service

```bash
cp /opt/brr/repo/deploy/hostinger/brr-api.service.example \
   /etc/systemd/system/brr-api.service

systemctl daemon-reload
systemctl enable brr-api
systemctl start brr-api
systemctl status brr-api
```

Watch the logs to confirm it started cleanly:

```bash
journalctl -u brr-api -f
```

Expected output on first boot (schemas are bootstrapped automatically):

```
[db] Schema "balaji_schema" is ready.
[db] Migrations applied from .../migrations
Server listening { port: 8080 }
```

---

## Step 7 — Install Nginx

```bash
mkdir -p /var/www/brr-web
cp -R /opt/brr/repo/release/web/. /var/www/brr-web/
chown -R www-data:www-data /var/www/brr-web

cp /opt/brr/repo/deploy/hostinger/nginx.conf.example \
   /etc/nginx/conf.d/brr.conf

# Edit server_name if you have a domain:
# nano /etc/nginx/conf.d/brr.conf
# Change:  server_name _;
# To:      server_name yourdomain.com www.yourdomain.com;

nginx -t && systemctl enable nginx && systemctl restart nginx
```

Open your browser at `http://YOUR_VPS_IP` — the BRR Liquor Soft landing page
should appear.

---

## Step 8 — Multi-Shop Setup (Multiple Schemas)

The app uses one PostgreSQL **schema per shop** on the same database. Schemas
are bootstrapped automatically when a shop is first logged into — no manual SQL
is needed.

If you want each shop on its own **subdomain** with its own API process:

```bash
# Env file per shop — change PORT and DB_SCHEMA in each
cp /etc/brr/brr-api.env /etc/brr/brr-api-balaji.env   # PORT=8080, DB_SCHEMA=balaji_schema
cp /etc/brr/brr-api.env /etc/brr/brr-api-jyothi.env   # PORT=8081, DB_SCHEMA=jyothi_schema
cp /etc/brr/brr-api.env /etc/brr/brr-api-padma.env    # PORT=8082, DB_SCHEMA=padma_schema
cp /etc/brr/brr-api.env /etc/brr/brr-api-mallanna.env # PORT=8083, DB_SCHEMA=mallanna_schema

# Service per shop
for shop in balaji jyothi padma mallanna; do
  cp /etc/systemd/system/brr-api.service \
     /etc/systemd/system/brr-api-${shop}.service
  # Edit EnvironmentFile= in each to point at the matching .env
  sed -i "s|EnvironmentFile=.*|EnvironmentFile=/etc/brr/brr-api-${shop}.env|" \
     /etc/systemd/system/brr-api-${shop}.service
done

systemctl daemon-reload
systemctl enable --now brr-api-balaji brr-api-jyothi brr-api-padma brr-api-mallanna
```

Then uncomment the multi-tenant server blocks in
`/etc/nginx/conf.d/brr.conf` and `systemctl reload nginx`.

---

## Step 9 — Optional: Add HTTPS with Let's Encrypt

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

After certbot runs, update `/etc/brr/brr-api.env`:

```
NODE_ENV=production
```

Then restart the service:

```bash
systemctl restart brr-api
```

---

## Ongoing Deployments

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
| `502 Bad Gateway` | API not running | `systemctl status brr-api` + `journalctl -u brr-api -n 50` |
| `ECONNREFUSED` to PostgreSQL | Wrong host/port or PostgreSQL not running | `systemctl status postgresql` + check DATABASE_URL |
| `password authentication failed` | Wrong DB password | Re-check DATABASE_URL in `/etc/brr/brr-api.env` |
| `role "brr" does not exist` | DB user not created | Re-run Step 2 in psql |
| CORS errors in browser | Domain mismatch | Set `CORS_ORIGIN=http://yourdomain.com` in env file |
| Session lost after restart | SESSION_SECRET changed | Keep SESSION_SECRET stable — changing it logs everyone out |
| `401` on every request after login | Cookie Secure flag mismatch | Ensure `NODE_ENV=http` when serving over plain HTTP |
