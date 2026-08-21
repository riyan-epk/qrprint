# QRPrint server image.
FROM node:20-alpine

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source.
COPY server ./server
COPY scripts ./scripts

# Data (db.json, uploads, logs) lives here — mount a volume to persist it.
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 3000

# Basic container healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
