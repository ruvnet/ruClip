# ruclip-attester — standalone Cloud Run service
# (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §2). Builds from the repo root
# (this service is part of the same TypeScript project as ruClip's own
# control-plane code — see tsconfig.json's `include` — not a separate
# npm workspace) and runs only the compiled attester entrypoint.
#
# Deploy (once the two secrets named in signing-key.ts/identity-map.ts are
# provisioned — a deployment step outside this code, per credential-issuer.ts's
# own established pattern):
#
# CORRECTION (2026-09-01, live-testing finding, docs/PLAN.md commit 1fbdd2e):
# `gcloud run deploy ruclip-attester --source .` from the repo ROOT does
# NOT find this Dockerfile (it lives in services/ruclip-attester/, not
# source root) and silently falls back to Buildpacks. Confirmed directly
# via `gcloud builds submit --help`: `gcloud builds submit --tag` has no
# `-f`/`--dockerfile` override flag to point it at a Dockerfile in a
# subdirectory. The command below IS verified — built and ran this exact
# image locally (`docker build` + `docker run` + a real `curl /health`
# returning 200) before writing it down as fact, same discipline this
# project holds for every other command documented as working:
#
#   docker build -f services/ruclip-attester/Dockerfile -t <IMAGE> .
#   docker push <IMAGE>
#   gcloud run deploy ruclip-attester \
#     --image=<IMAGE> \
#     --no-allow-unauthenticated \
#     --set-env-vars RUCLIP_ATTESTER_SIGNING_SECRET=...,RUCLIP_ATTESTER_SIGNING_PROJECT=...,RUCLIP_ATTESTER_IDENTITY_MAP_SECRET=...,RUCLIP_ATTESTER_IDENTITY_MAP_PROJECT=...
#
# Alternative (not verified here, untested): a `cloudbuild.yaml` with an
# explicit `docker build -f services/ruclip-attester/Dockerfile -t <IMAGE> .`
# step, submitted via `gcloud builds submit --config=cloudbuild.yaml .`
# (no `--tag` — `--config` and `--tag` are mutually exclusive on this CLI).

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
