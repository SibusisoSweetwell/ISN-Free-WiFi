<<<<<<< HEAD
# ISN Free WiFi Portal & Captive Proxy

This project provides a lightweight ad‑funded captive portal with data bundle gating powered by a local HTTP(S) proxy. Users:
1. Connect to the PC / hotspot Wi‑Fi.
2. Configure their device/browser to use the local proxy (manual or PAC URL).
3. Visit the portal (home.html), login/register, pick a bundle, watch an ad.
4. After ad completion a data bundle is granted; browsing is unlocked until quota is exhausted.
5. When bundle is finished access is re‑gated until another ad sequence is completed.

## Quick Start

Install dependencies:
```bash
# ISN Free WiFi Portal & Captive Proxy

Delivering dignified internet access for everyday South Africans since 2025.

This project provides a lightweight ad‑funded captive portal with data bundle gating powered by a local HTTP(S) proxy. Users:
1. Connect to the PC / hotspot Wi‑Fi.
2. Configure their device/browser to use the local proxy (manual or PAC URL).
3. Visit the portal (`home.html`), login/register, pick a bundle, watch an ad.
4. After ad completion a data bundle is granted; browsing is unlocked until quota is exhausted.
5. When bundle is finished access is re‑gated until another ad sequence is completed.

## Quick Start

Install dependencies:
```bash
npm install
```
Run server (Express portal + captive proxy):
```bash
node server.js
```
Environment variables (optional):
- `PORT` Portal HTTP port (default 3100; auto increments if busy)
- `PROXY_PORT` Proxy port (default 3128)
- `ENABLE_PROXY=false` Disable starting proxy
- `WALLED_GARDEN` Comma separated hostnames allowed pre‑auth
- `FULL_UNLOCK_AFTER_AD=true` If set to `true` grants full access regardless of quota after first ad completion

## Device Proxy Setup

After server start open: `http://<PC_LAN_IP>:<PORT>/home.html`.

Automatic (PAC):
Use PAC URL: `http://<PC_LAN_IP>:<PORT>/proxy.pac`

Manual:
- Host: `<PC_LAN_IP>`
- Port: `<PROXY_PORT>`

The Help & Support overlay in `home.html` auto-populates these values via `/api/portal/config`.

## Data Bundles & Accounting
- Bundles stored in `logins.xlsx` sheet `Purchases` (bundleMB / usedMB values).
- Usage added passively by proxy (bytes converted to MB and added to most recent active purchase) plus demo client pings.
- When quota exhausted user receives HTTP 429 or redirect forcing ad portal.

## Ads & Rewards
- Video/image/YouTube ads list seeded (see `DEFAULT_AD_URLS`).
- Every 30 seconds of view time rewards 5MB by default (config constants in code: `AD_REWARD_SECONDS`, `AD_REWARD_MB`).
- On ad completion a short-lived eligibility ticket allows bundle grant (`source: ad-sequence`).

## Security Notes
This is a demo / prototype:
- No HTTPS interception (CONNECT tunnels are passed through; only byte counted).
- Workbook (Excel) is a flat file; concurrent writes can conflict if opened manually.
- Authentication token is a simple HMAC (not JWT) and only used for portal<->proxy linkage.

## Admin
Set `ADMIN_EMAIL` inside `server.js` (currently hardcoded). Admin endpoints require `x-user-identifier` header matching admin email (or associated phone).

## Reset / Data Clearing
Stop the server and delete `logins.xlsx` to reset all users, bundles, sessions, ads, and logs.

## Disclaimer
Educational prototype; not hardened for production. Add proper database, TLS, per-device identification (MAC), and stronger auth before real deployments.
