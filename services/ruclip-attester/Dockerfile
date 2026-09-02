# ruclip-attester — standalone Cloud Run service
# (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §2). Builds from the repo root
# (this service is part of the same TypeScript project as ruClip's own
# control-plane code — see tsconfig.json's `include` — not a separate
# npm workspace) and runs only the compiled attester entrypoint.
#
# Deploy (once the two secrets named in signing-key.ts/identity-map.ts are
# provisioned — a deployment step outside this code, per credential-issuer.ts's
# own established pattern):
#   gcloud run deploy ruclip-attester \
#     --source . \
#     --no-allow-unauthenticated \
#     --set-env-vars RUCLIP_ATTESTER_SIGNING_SECRET=...,RUCLIP_ATTESTER_SIGNING_PROJECT=...,RUCLIP_ATTESTER_IDENTITY_MAP_SECRET=...,RUCLIP_ATTESTER_IDENTITY_MAP_PROJECT=...

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY services ./services
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund --omit=dev --omit=peer
COPY --from=build /app/dist ./dist

# Cloud Run's own $PORT convention (autogenous-service's own Dockerfile, per
# AUTOGENOUS-RUNTIME-GOVERNANCE.md §0, uses the same convention).
EXPOSE 8080
CMD ["node", "dist/services/ruclip-attester/src/server.js"]
