# Use Node.js base image
FROM node:18

# Set working directory
WORKDIR /app

# Copy files
COPY . .

# Install dependencies
RUN npm ci --no-audit --no-fund

# Default PORT (can be overridden at runtime)
ENV PORT=3100
# Default RENDER_HOST (can be overridden in container env)
ENV RENDER_HOST=isn-free-wifi.onrender.com
ENV USE_SQLITE=true
ENV SQLITE_PATH=/data/data.sqlite

# Expose port
EXPOSE 3100

# Persist SQLite DB on /data so platform volumes (Render, Docker) can keep it across restarts
VOLUME ["/data"]

# Seed the SQLite DB at build time so free-tier deployments have initial users
RUN node scripts/seed_logins_db.js || echo "Seed step (build) failed - continuing"

# Start script will seed at runtime only if DB missing, then start server
CMD ["node", "start.js"]
