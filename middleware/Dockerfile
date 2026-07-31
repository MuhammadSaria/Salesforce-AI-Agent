FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @salesforce/cli@2.120.3 @openai/codex@0.144.4 \
    && git config --system user.name "Providus Nexus" \
    && git config --system user.email "providus-nexus@localhost"

WORKDIR /app
COPY middleware/package.json middleware/package-lock.json ./
RUN npm ci --omit=dev

COPY middleware/src ./src
COPY middleware/config ./config
COPY middleware/redis.conf ./redis.conf

ENV NODE_ENV=production \
    PORT=3000 \
    PROJECT_ROOT=/workspace \
    WORKSPACE_ROOT=/workspace \
    SALESFORCE_ORG_REGISTRY_PATH=/workspace/middleware/config/org-registry.json

EXPOSE 3000
CMD ["node", "src/server.js"]
