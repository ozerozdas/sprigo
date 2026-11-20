# Optional self-hosted web edition

This Docker Compose deployment serves Sprigo in a browser. It is separate from the Tauri desktop app and its [phone companion](docs/MOBILE.md). The browser provides the screen, microphone and speaker; the server runs the UI, a restricted Ollama proxy and CPU-based faster-whisper (`base.en`). Piper runs in the browser and downloads its voice on first use.

## Start

Requires Docker Compose, OpenSSL and an Ollama server reachable from Docker. Pull the configured model in Ollama first (`ollama pull qwen3:8b` by default). Set `SPRIGO_MODEL` in `.env` if you prefer a different installed model. Ollama must be reachable from inside the container; on Linux, the default host gateway URL may require you to configure Ollama to listen beyond `127.0.0.1`, or set `SPRIGO_OLLAMA_URL` to another reachable endpoint. Whisper downloads its model on the first transcription.

```sh
cp .env.example .env
# Edit .env: set SPRIGO_BIND_IP to this server's LAN or VPN address for other devices.
# Set SPRIGO_UID and SPRIGO_GID to the local account that runs Docker (id -u, id -g).
./scripts/web-cert.sh 192.168.1.50  # replace with the address or DNS name used in the browser
mkdir -p server-data models
# Make sure the configured UID/GID can write server-data and models.
docker compose up -d --build
```

Open `https://<address>:1431/` (or the configured HTTPS port). A phone's microphone requires a trusted HTTPS connection. The generated local CA certificate is `certs/ca.crt`; install it on each device through a trusted transfer and verify its fingerprint. The certificate is also available at `http://<address>:1432/ca.crt` on a trusted LAN, but an HTTP download alone cannot authenticate a CA certificate. To see the fingerprint on the server:

```sh
openssl x509 -in certs/ca.crt -noout -fingerprint -sha256
```

If you already have a trusted TLS certificate for the chosen address, place its certificate, key and issuer certificate at `certs/server.crt`, `certs/server.key` and `certs/ca.crt`. The certificate download port is optional. Do not expose this deployment directly to the public internet without reviewing its authentication and proxy access controls.

## Data and devices

By default, each browser stores its profiles and progress in IndexedDB. Settings → Profile offers an optional server account. Create it on the device with the progress you want, leave **Copy the profiles and progress from this device** selected, then sign in on another browser. The shared database lives in `server-data/accounts/`; `server-data/` must be backed up separately. Switching back to local mode preserves that browser's previous local database. Local databases from different devices are not merged. The Tauri desktop app keeps its own data and is not synchronized with these web accounts.

Account sessions use a Secure, HttpOnly cookie. Passwords are hashed. For a private LAN, an account may have no password; anyone who can reach the server and knows its username can then open it. A four-character password is accepted for convenience but is weak; use a stronger one if others can reach the network. There is no self-service password recovery.

Only the configured Ollama model is proxied. The web edition currently transcribes **English only** with `base.en`. Other course languages need a multilingual Whisper model. The generated CA private key and server key stay in the ignored `certs/` directory; never commit them. The separate desktop app's Tailscale phone mode remains available.
