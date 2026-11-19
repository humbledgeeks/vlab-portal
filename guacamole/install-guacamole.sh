#!/usr/bin/env bash
# Installs Apache Guacamole (browser remote desktop for vLab Portal's "Connect" button)
# on a Linux host, as two containers: guacd + guacamole (web), with encrypted-JSON login only.
#
#   Podman (RHEL / Rocky / Alma 9+): rootless, systemd user units (Quadlet), survives reboot
#   Docker (Ubuntu / Debian / others): containers with --restart unless-stopped
#
# Usage:   ./install-guacamole.sh [port]        (default port 8085)
# Prints the URL and the JSON secret key to give to the portal installer.
set -euo pipefail

PORT="${1:-8085}"
VERSION="1.6.0"
DIR="$HOME/guacamole"
ENVFILE="$DIR/guacamole.env"

mkdir -p "$DIR"
if [[ ! -f "$ENVFILE" ]]; then
  ( umask 077
    printf 'GUACD_HOSTNAME=127.0.0.1\nGUACD_PORT=4822\nJSON_SECRET_KEY=%s\n' "$(openssl rand -hex 16)" > "$ENVFILE" )
fi
KEY="$(grep '^JSON_SECRET_KEY=' "$ENVFILE" | cut -d= -f2)"

if command -v podman >/dev/null 2>&1; then
  echo "==> Podman found: installing rootless Quadlet units for $USER"
  podman pull -q "docker.io/guacamole/guacd:$VERSION" >/dev/null
  podman pull -q "docker.io/guacamole/guacamole:$VERSION" >/dev/null
  Q="$HOME/.config/containers/systemd"; mkdir -p "$Q"
  cat > "$Q/guacamole.pod" <<EOF
[Pod]
PodName=guacamole
PublishPort=$PORT:8080
EOF
  cat > "$Q/guacd.container" <<EOF
[Unit]
Description=Guacamole proxy daemon (guacd)
[Container]
Image=docker.io/guacamole/guacd:$VERSION
ContainerName=guacd
Pod=guacamole.pod
[Service]
Restart=always
[Install]
WantedBy=default.target
EOF
  cat > "$Q/guacamole-web.container" <<EOF
[Unit]
Description=Guacamole web app (encrypted JSON auth for vLab Portal)
Requires=guacd.service
After=guacd.service
[Container]
Image=docker.io/guacamole/guacamole:$VERSION
ContainerName=guacamole-web
Pod=guacamole.pod
EnvironmentFile=%h/guacamole/guacamole.env
[Service]
Restart=always
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user restart guacamole-pod.service guacd.service guacamole-web.service
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
    echo "!! Run once so Guacamole keeps running after you log out and starts at boot:"
    echo "     sudo loginctl enable-linger $USER"
  fi
elif command -v docker >/dev/null 2>&1; then
  echo "==> Docker found: starting containers"
  docker network inspect guacamole >/dev/null 2>&1 || docker network create guacamole >/dev/null
  docker rm -f guacd guacamole-web >/dev/null 2>&1 || true
  docker run -d --name guacd --network guacamole --restart unless-stopped "guacamole/guacd:$VERSION" >/dev/null
  sed 's/^GUACD_HOSTNAME=.*/GUACD_HOSTNAME=guacd/' "$ENVFILE" > "$DIR/docker.env"; chmod 600 "$DIR/docker.env"
  docker run -d --name guacamole-web --network guacamole --restart unless-stopped \
    --env-file "$DIR/docker.env" -p "$PORT:8080" "guacamole/guacamole:$VERSION" >/dev/null
else
  echo "Neither podman nor docker is installed. Install one of them and run this again." >&2
  exit 1
fi

echo "==> Waiting for Guacamole to answer on port $PORT"
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/guacamole/"; then OK=1; break; fi
  sleep 2
done
[[ "${OK:-}" == 1 ]] || { echo "Guacamole did not start; check: podman logs guacamole-web (or docker logs guacamole-web)" >&2; exit 1; }

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active -q firewalld; then
  if ! firewall-cmd --list-ports 2>/dev/null | grep -qw "$PORT/tcp"; then
    echo "!! Open the port so the portal and browsers can reach Guacamole:"
    echo "     sudo firewall-cmd --permanent --add-port=$PORT/tcp && sudo firewall-cmd --reload"
  fi
elif command -v ufw >/dev/null 2>&1 && sudo -n ufw status 2>/dev/null | grep -q active; then
  echo "!! If ufw blocks it:  sudo ufw allow $PORT/tcp"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

============================================================
 Guacamole $VERSION is running.
 Give these two values to the vLab Portal installer:

   Guacamole URL : http://${IP:-<this-host>}:$PORT/guacamole
   JSON key      : $KEY

 (The key is stored in $ENVFILE. Keep it secret:
  anyone with it can open desktops through this Guacamole.)
============================================================
EOF
