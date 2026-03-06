# Web Manager Dockerfile
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY manager/package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy service files first
COPY manager .

# Copy shared dependencies to parent directory (for ../../shared imports)
COPY shared /shared

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start service
CMD ["node", "dist/index.js"]
