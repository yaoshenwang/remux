# E16-006: Docker self-hosted image for Remux
FROM node:20-slim

WORKDIR /app

# Install only production dependencies
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

# Copy built server and assets
COPY server.js ./
COPY node_modules/ghostty-web/dist/ ./node_modules/ghostty-web/dist/
COPY node_modules/ghostty-web/ghostty-vt.wasm ./node_modules/ghostty-web/

# Default port
ENV PORT=8767

EXPOSE 8767

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8767/ || exit 1

ENTRYPOINT ["node", "server.js"]
