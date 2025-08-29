Render deployment notes

- Set environment variables for Render service:
  - PORT (optional, default 3150)
  - PROXY_PORT (optional, default 8082)
  - USE_SQLITE=true
  - SQLITE_PATH (optional, default ./data.sqlite)
  - PORTAL_SECRET (recommended)

- The provided Dockerfile will install dependencies and run `node server.js`.
- Render will build and run the service; the app exposes port 3150.
- For secure logins in production, configure TLS/HTTPS at the load balancer or use Render's managed TLS.

Notes:
- GitHub Pages is not appropriate; this deploy is a full Node app with SQLite local DB.
- If multiple instances are required, move SQLite to a shared DB (Postgres) and set USE_SQLITE=false.
