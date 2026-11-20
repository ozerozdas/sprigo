#!/usr/bin/env bash
set -euo pipefail

host=${1:-}
if [[ ! "$host" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Usage: $0 <LAN IP address or DNS name>" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
mkdir -p certs
if [[ -e certs/ca.key || -e certs/server.key ]]; then
  echo "Existing certificate keys found in certs/. Move them away before generating a new CA." >&2
  exit 1
fi
if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  san="IP:$host"
else
  san="DNS:$host"
fi
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -sha256 \
  -subj "/CN=Sprigo local CA" -keyout certs/ca.key -out certs/ca.crt
openssl req -new -newkey rsa:3072 -nodes -sha256 \
  -subj "/CN=$host" -keyout certs/server.key -out certs/server.csr
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san" > certs/server.ext
openssl x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -days 825 -sha256 -extfile certs/server.ext -out certs/server.crt
rm certs/server.csr certs/server.ext certs/ca.srl
chmod 600 certs/ca.key certs/server.key
openssl x509 -in certs/ca.crt -noout -fingerprint -sha256
