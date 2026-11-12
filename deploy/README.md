# Production deployment (poker.naebka.win)

```
GitHub push to main ──► Actions: tests ──► build images ──► ghcr.io/kadyrsky/casino_v2-{core,live}:<sha>
                                                        └─► SSH to server: server-deploy.sh <sha>
Server /opt/naebka:  sni-router (443) ─► caddy (80, HTTPS) ──► core:8081 ──► postgres, redis ◄── watcher, odds-engine
```

| File | Purpose |
|---|---|
| `.github/workflows/ci-cd.yml` | Tests on every push/PR; on `main` also builds, pushes and deploys |
| `deploy/docker-compose.prod.yml` | Production stack (prebuilt images, only Caddy is public, memory limits for 1 GB RAM) |
| `deploy/Caddyfile` | Reverse proxy + automatic Let's Encrypt certificate for `SITE_DOMAIN` |
| `deploy/haproxy.cfg` | SNI router on public 443: `poker.naebka.win` → Caddy, anything else → Amnezia VPN |
| `deploy/server-deploy.sh` | Runs on the server: pull the tag, restart, wait for health, roll back on failure |

## Server

Ubuntu, Docker + Compose plugin, 2 GB swap, `ufw` (22, 80, 443 only), `fail2ban`, user `deploy` (docker group).
Everything lives in `/opt/naebka`; secrets are in `/opt/naebka/.env` (mode 600, never in git).

## Port 443 is shared with the Amnezia VPN

The server also runs an Amnezia VPN (`amnezia-xray`, VLESS + Reality). `sni-router` (HAProxy) owns public port 443
and routes by TLS server name: `poker.naebka.win` goes to Caddy (`127.0.0.1:8443`, real client IP via PROXY
protocol), everything else goes to xray (`127.0.0.1:8444`). VPN clients need no changes.

If the Amnezia app re-installs or re-creates xray, it will publish `0.0.0.0:443` again and the router won't start.
Re-create it on the internal port (same image, volume and network; `/root/amnezia-xray-start.sh` is Amnezia's start
script, which lives inside the container, not in the volume):

```bash
docker rm -f amnezia-xray
docker create --name amnezia-xray --restart always --privileged --cap-add NET_ADMIN --log-driver none \
  -e TZ=Asia/Shanghai -v amnezia-xray-data:/opt/amnezia/xray --network amnezia-dns-net \
  -p 127.0.0.1:8444:443/tcp amnezia-xray
docker network connect bridge amnezia-xray
docker cp /root/amnezia-xray-start.sh amnezia-xray:/opt/amnezia/start.sh
docker start amnezia-xray
cd /opt/naebka && docker compose -f docker-compose.prod.yml up -d
```

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

## DNS (Cloudflare)

`poker.naebka.win` is a Cloudflare record pointing to the server IP, **proxied** (orange cloud):

- SSL/TLS mode must be **Full** or **Full (strict)** — *Flexible* would loop, because the origin redirects HTTP to HTTPS.
- The origin keeps its own Let's Encrypt certificate (Caddy renews it with the HTTP challenge, which Cloudflare passes
  through), so *Full (strict)* works.
- Caddy trusts `CF-Connecting-IP` only from Cloudflare's IP ranges (listed in `deploy/Caddyfile`), so the core sees
  real visitor IPs (login lockouts, rate limits, poker same-IP blocking) and a direct visitor can't spoof one.
- WebSockets (`/ws`) work through Cloudflare with no extra settings.
- `http://<server ip>` redirects to `https://poker.naebka.win`.

If you ever switch to *DNS only* (grey cloud), nothing needs to change.

Editing `Caddyfile` on the server: overwrite it in place (`cat new > Caddyfile`, or `scp`), not with `mv` — the
container's bind mount keeps pointing at the old file. Then:
`docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.

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

## Music

Deadlock's music is in the repository (`frontend/public/music`, ~37 MB; the repository and its images are private) and
is built into the core image, so the server needs nothing for it. Check <https://poker.naebka.win/music/manifest.json>
lists 36 files. The audio is Valve's: if the repository is ever made public, remove the folder from git first.

## Feedback file

Besides the database, every rating, reason and comment is appended to `/opt/naebka/data/feedback.jsonl` on the server:
one JSON object per line, never rewritten, so it survives a lost database and anyone with SSH access can read it.
`"event": "feedback"` lines are new ratings; `"event": "details"` lines add reasons or a comment to the rating with
the same `id`. To copy it to your computer:

```bash
scp deploy@<server ip>:/opt/naebka/data/feedback.jsonl .
```
