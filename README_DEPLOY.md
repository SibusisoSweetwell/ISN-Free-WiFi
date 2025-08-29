Quick deploy & test notes

1) Seed the SQLite DB locally (creates logins.db with test users):

PowerShell:
$env:USE_SQLITE='true'; node scripts/seed_logins_db.js

2) Start server locally (proxy disabled for local testing):

PowerShell:
$env:ENABLE_PROXY='false'; $env:USE_SQLITE='true'; $env:PORT=3100; node server.js

3) Test form login in browser:
- Open: http://localhost:3100/login.html
- Use credentials from seed script, e.g. alice@example.com / Alice@1234

4) Render deployment notes:
- Ensure Render service uses the repository and sets the following Environment variables:
  - PORT (Render sets this automatically)
  - USE_SQLITE=true
  - RENDER_HOST=isn-free-wifi.onrender.com
  - (Optional) SQLITE_PATH if you prefer a custom DB path
- Dockerfile already uses CMD ["node","server.js"] and defaults to PORT=3100

5) Proxy behavior:
- The proxy listens on port 8082 and will forward requests to the remote portal host (isn-free-wifi.onrender.com) when configured. Set RENDER_HOST env on the proxy host if different.

If you want, I can update the Render deployment settings or create a small health check endpoint for Render to use.
