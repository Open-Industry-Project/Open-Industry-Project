#!/usr/bin/env bash
# One-command redeploy of server/ to the collab VM. Run from the repo root:
#
#   bash server/deploy.sh
#
# The default target `oip-collab` is an SSH host alias: define it once in your
# ~/.ssh/config (HostName <vm-ip>, User azureuser) so no VM IP lives in the repo.
# Override for a different box or a one-off host:
#
#   HOST=azureuser@1.2.3.4 bash server/deploy.sh
#
# This is the deliberate, manual deploy path (see server/DEPLOY.md): the collab server
# changes rarely, so we don't store a privileged VM SSH key in GitHub Actions just to
# automate a redeploy. It ships only server/ (no node_modules, no dev DB), reinstalls
# prod deps, restarts the service, and checks the wss:// handshake.
set -euo pipefail

HOST="${HOST:-oip-collab}"
DOMAIN="${DOMAIN:-collab.openindustryproject.org}"
TARBALL="$(mktemp -t oip-server-XXXXXX).tgz"
trap 'rm -f "$TARBALL"' EXIT

echo ">>> packaging server/ ..."
tar -czf "$TARBALL" -C server --exclude=node_modules --exclude='*.sqlite' .

echo ">>> uploading to $HOST ..."
scp -o StrictHostKeyChecking=accept-new "$TARBALL" "$HOST:/tmp/oip-server.tgz"

echo ">>> installing + restarting on the VM ..."
ssh -o StrictHostKeyChecking=accept-new "$HOST" '
  set -e
  sudo tar -xzf /tmp/oip-server.tgz -C /opt/oip-web/server
  sudo chown -R oip:oip /opt/oip-web/server
  cd /opt/oip-web/server
  sudo -u oip env HOME=/opt/oip-web npm ci --omit=dev
  # install/refresh the nightly-backup units shipped in server/systemd (idempotent);
  # sqlite3 is the CLI backup.sh uses. cloud-init installs it on new VMs, and this covers old ones
  command -v sqlite3 >/dev/null || sudo apt-get install -y sqlite3
  sudo chmod +x /opt/oip-web/server/backup.sh
  sudo cp /opt/oip-web/server/systemd/oip-collab-backup.service /opt/oip-web/server/systemd/oip-collab-backup.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now oip-collab-backup.timer
  # the server binds 127.0.0.1 only (index.mjs HOST); a Caddyfile from an older cloud-init proxies to
  # localhost, which may resolve to ::1 first, so point it at the IPv4 loopback explicitly (idempotent)
  if grep -q "reverse_proxy localhost:1234" /etc/caddy/Caddyfile; then
    sudo sed -i "s/reverse_proxy localhost:1234/reverse_proxy 127.0.0.1:1234/" /etc/caddy/Caddyfile
    sudo systemctl reload caddy
  fi
  sudo systemctl restart oip-collab.service
  sleep 2
  if systemctl is-active --quiet oip-collab.service; then
    echo "service: active"
  else
    echo "service FAILED — recent logs:"; sudo journalctl -u oip-collab -n 20 --no-pager; exit 1
  fi
'

echo ">>> websocket handshake check (101 = good) ..."
if curl -isS -N --max-time 8 \
     -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
     "https://$DOMAIN/" 2>&1 | grep -qm1 "101 Switching Protocols"; then
  echo "OK — wss://$DOMAIN is live"
else
  echo "WARN: did not observe a 101 handshake; check manually (the service may still be fine)"
fi
echo ">>> done."
