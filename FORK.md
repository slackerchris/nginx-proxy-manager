# nginx-proxy-manager — Personal Fork

This is a personal fork of [NginxProxyManager/nginx-proxy-manager](https://github.com/NginxProxyManager/nginx-proxy-manager) by [@slackerchris](https://github.com/slackerchris).

The upstream `develop` branch is tracked as the `upstream/develop` remote. Custom features live on the `develop` branch of this fork and are merged in via feature branches.

---

## Added Features

### 1. Backup & Restore

**Branch:** `feature/backup-restore` (merged)

Download a full backup of your NPM configuration, or restore from a previously downloaded archive.

**What gets backed up:**
- SQLite database
- Nginx configuration files
- SSL certificates

**Backend:**
- `GET /backup/download` — streams a `.tar.gz` archive of the data directory
- `POST /backup/restore` — accepts a `.tar.gz` upload and overwrites the current data directory

**Frontend:**
- Settings page → *Backup & Restore* card
- Download button triggers a file-save of the archive
- Restore: pick a `.tar.gz` file, tick the confirmation checkbox, click Restore
- After a successful restore a persistent **yellow banner** appears reminding you to restart the service (it stays visible until dismissed — it won't auto-hide)

**Gotcha:** A service restart is required after restore for changes to take effect.

---

### 2. Certificate Expiry Badges

**Branch:** `feature/cert-expiry` (merged)

The Certificates page now shows a coloured badge next to each certificate's expiry date so you can spot problems at a glance.

| Badge | Meaning |
|-------|---------|
| 🟢 Green | Expires in > 30 days |
| 🟡 Yellow | Expires in 15–30 days |
| 🔴 Red | Expires in 0–14 days |
| Grey "Expired" | Already expired |

Uses `date-fns` (`differenceInDays`, `isPast`) — already a project dependency.

---

### 3. Duplicate Forward-Host Detection

**Branch:** `feature/qol-improvements` (merged)

If two or more proxy hosts point to the same `forwardHost:forwardPort`, NPM now warns you.

- A yellow alert banner appears above the Proxy Hosts table listing how many duplicate destinations exist
- Each affected row shows a small ⚠ icon inline in the Destination column (hover for tooltip)

This is purely client-side — no backend changes needed.

---

## Development Setup

### Requirements

- Docker (for running the backend)
- Node 20+ / Node 22 recommended (use [nvm](https://github.com/nvm-sh/nvm))
- Yarn (`npm install -g yarn` under the correct Node version)

> **Note:** The host Node 18 bundled with many distros is **not** sufficient for the backend. Use `nvm use 22` before running any npm/yarn commands.

### Backend

The backend is run in a Docker container to avoid Node version conflicts:

```bash
docker run -d \
  --name npm-test-backend \
  -p 3000:3000 \
  -v ~/npm-data:/data \
  node:22-slim \
  sh -c "cd /app && node index.js"
```

Default admin credentials: `admin@example.com` / `changeme1`

### Frontend (dev server)

```bash
cd frontend
nvm use 22
yarn install
yarn dev          # starts Vite at http://localhost:5173
```

Vite proxies `/api/*` → `http://localhost:3000/*` (prefix stripped), configured in `frontend/vite.config.ts`.

---

## Building & Deploying

### 1. Build the frontend

```bash
cd ~/npm-fork/frontend
nvm use 22
yarn install
yarn build          # outputs to frontend/dist/
cd ..
```

### 2. Build the Docker image

```bash
docker build \
  -f docker/Dockerfile \
  -t slackerchris/nginx-proxy-manager:latest \
  --build-arg BUILD_VERSION=fork-dev \
  --build-arg BUILD_COMMIT=$(git rev-parse --short HEAD) \
  --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  .
```

### 3. Get the image onto your target host

**Option A — tarball (no registry needed):**

```bash
docker save slackerchris/nginx-proxy-manager:latest | gzip > npm-fork.tar.gz
scp npm-fork.tar.gz user@your-host:/tmp/
# on the target:
docker load < /tmp/npm-fork.tar.gz
```

**Option B — push to GitHub Container Registry (GHCR):**

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u slackerchris --password-stdin
docker tag slackerchris/nginx-proxy-manager:latest ghcr.io/slackerchris/nginx-proxy-manager:latest
docker push ghcr.io/slackerchris/nginx-proxy-manager:latest
# on the target:
docker pull ghcr.io/slackerchris/nginx-proxy-manager:latest
```

### 4. Run it (LXC / any Docker host)

**LXC requirements (Proxmox):** Docker needs either a privileged container, or an unprivileged container with `features: nesting=1,keyctl=1` set in the LXC config.

```bash
# Install Docker on the LXC (Debian/Ubuntu)
apt update && apt install -y docker.io docker-compose-plugin
```

Create `/opt/npm/docker-compose.yml`:

```yaml
services:
  npm:
    image: slackerchris/nginx-proxy-manager:latest
    container_name: npm
    restart: unless-stopped
    ports:
      - "80:80"
      - "81:81"    # admin UI
      - "443:443"
    environment:
      DB_SQLITE_FILE: "/data/database.sqlite"
      PUID: 1000
      PGID: 1000
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
```

```bash
mkdir -p /opt/npm/data /opt/npm/letsencrypt
cd /opt/npm
docker compose up -d
```

Admin UI: `http://<host-ip>:81`  
Default login: `admin@example.com` / `changeme`

---

## Pulling Upstream Changes

```bash
git fetch upstream
git checkout develop
git merge upstream/develop
```

Resolve any conflicts, then push:

```bash
git push origin develop
```
