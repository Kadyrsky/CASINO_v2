# Production deployment (poker.naebka.win)

```
GitHub push to main ──► Actions: tests ──► build images ──► ghcr.io/kadyrsky/casino_v2-{core,live}:<sha>
                                                        └─► SSH to server: server-deploy.sh <sha>
Server /opt/naebka:  caddy (80/443, HTTPS) ──► core:8081 ──► postgres, redis ◄── watcher, odds-engine
```

| File | Purpose |
|---|---|
| `.github/workflows/ci-cd.yml` | Tests on every push/PR; on `main` also builds, pushes and deploys |
| `deploy/docker-compose.prod.yml` | Production stack (prebuilt images, only Caddy is public, memory limits for 1 GB RAM) |
| `deploy/Caddyfile` | Reverse proxy + automatic Let's Encrypt certificate for `SITE_DOMAIN` |
| `deploy/server-deploy.sh` | Runs on the server: pull the tag, restart, wait for health, roll back on failure |

## Server

Ubuntu, Docker + Compose plugin, 2 GB swap, `ufw` (22, 80, 443 only), `fail2ban`, user `deploy` (docker group).
Everything lives in `/opt/naebka`; secrets are in `/opt/naebka/.env` (mode 600, never in git).

## GitHub repository secrets

Settings → Secrets and variables → Actions → *New repository secret*:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | server IP |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | private key whose `.pub` is in `/home/deploy/.ssh/authorized_keys` (whole file, including the BEGIN/END lines) |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <server ip>` |

The images go to GHCR with the workflow's own `GITHUB_TOKEN`; the server logs in with the same short-lived token
during each deploy, so no registry secret is needed.

## DNS

Add an **A record** `poker` → server IP in the `naebka.win` zone (if it's on Cloudflare, use *DNS only*/grey cloud, at
least until the first certificate is issued). Caddy picks it up automatically. Before that, the site
answers on `http://<server ip>`.

## Day-to-day

```bash
ssh deploy@<server ip>
cd /opt/naebka
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f core
# Roll back to an earlier commit's images:
bash server-deploy.sh <older git sha> < /dev/null
# Backup the database:
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U naebka naebka | gzip > naebka-$(date +%F).sql.gz
```

Changing a value in `.env` (e.g. enabling MetaMask deposits) takes effect after
`docker compose -f docker-compose.prod.yml up -d`.
