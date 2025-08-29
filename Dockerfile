# Use Node.js base image
FROM node:18

# Set working directory
WORKDIR /app

# Copy files
COPY . .

# Install dependencies
RUN npm ci

# Expose port
EXPOSE 3150

# Start the app
CMD ["node", "server.js"]
