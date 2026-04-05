# E16-006: Docker self-hosted image for Remux
FROM node:24-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install only production dependencies and ship the bundled entrypoints
COPY package.json pnpm-lock.yaml server.js pty-daemon.js ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production

# Default port
ENV PORT=8767

EXPOSE 8767

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8767/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "server.js"]
