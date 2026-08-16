# WuxianPi Hub Deployment

This deployment runs the Hub on `127.0.0.1:20878` and exposes it through
Nginx at `https://wuxianpihub.webefficacy.com`.

## Deploy

Use a clean checkout at an approved commit:

```bash
git fetch origin main
git checkout --detach <approved-commit>
cd deployment/wuxianpi-hub
./deploy.sh
```

`deploy.sh` creates `runtime.env`, server-only `secrets.env`, `data/`, and
`backups/`. The secret file is mode `0600` and is ignored by Git. Do not copy
its contents into issue reports or client configuration.

## Nginx and TLS

Install the HTTP bootstrap first, obtain the certificate, and then install the
HTTPS configuration:

```bash
sudo install -d -m 0755 /var/www/letsencrypt
sudo install -m 0644 nginx-http.conf /etc/nginx/sites-available/wuxianpihub.webefficacy.com
sudo ln -sfn /etc/nginx/sites-available/wuxianpihub.webefficacy.com /etc/nginx/sites-enabled/wuxianpihub.webefficacy.com
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d wuxianpihub.webefficacy.com --non-interactive --agree-tos \
  --register-unsafely-without-email
sudo install -m 0644 nginx-https.conf /etc/nginx/sites-available/wuxianpihub.webefficacy.com
sudo nginx -t && sudo systemctl reload nginx
```

Certificate renewal remains managed by the existing Certbot timer.

## Operations

```bash
docker compose ps
docker compose logs --tail=200 hub
./rotate-secrets.sh
./backup.sh
RESTORE_CONFIRM=1 ./restore.sh backups/<archive>.tar.gz
```

The backup script briefly stops the Hub so the SQLite database and verified
screenshot cache are captured consistently. Docker logs are bounded to five
10 MiB files. Package verification uses a bounded temporary filesystem and
never executes Package build commands.

To enable the optional OpenHouse Git Mirror adapter, set
`HUB_MIRROR_SERVICE_URL` in `runtime.env` and set
`HUB_MIRROR_SERVICE_TOKEN` to the mirror service's `MIRROR_API_TOKEN` in
`secrets.env`. Mirror failures never block Package publication or GitHub
installation.

## Smoke Test

Public checks need no credentials:

```bash
../../integration/hub/run.sh
```

The default smoke test is always read-only, even when credentials are present.
The submit/verify/approve/install-plan path additionally requires
`HUB_PUBLISHER_TOKEN`, `HUB_ADMIN_TOKEN`, `PACKAGE_REPOSITORY`, `PACKAGE_REF`,
and the explicit `HUB_ALLOW_PERSISTENT_MUTATION=1` acknowledgement. Successful
production mutation intentionally leaves an immutable Release; use an isolated
Hub for disposable E2E. Failed flows reject their submission or revoke their
new Release. Set `HUB_COMPOSE_DIR` to this directory to include a container
restart and persistence check.
