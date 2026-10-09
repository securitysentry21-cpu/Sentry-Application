# One image for every service in the cell (ARCH §2): the API, the background worker, the dashboard,
# and the one-off database and operator tasks. Each ECS task definition picks its command
# (infra/terraform/cell/services.tf). Built for Arm (Graviton, ARCH §19.8) by CI, only after
# `pnpm verify` passes on main (.github/workflows/ci.yml › image), or by CodeBuild in the account
# (infra/terraform/cell/codebuild.tf). Build context: the repository root. The base image comes from
# AWS's mirror of the Docker official images, so build machines never hit Docker Hub's pull limits.
FROM public.ecr.aws/docker/library/node:24.16.0-bookworm-slim

ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.9.0 && npm cache clean --force

WORKDIR /repo
COPY . .

# The API, the dashboard, and the root tooling `next build` needs (TypeScript). The guard app is left
# out. NODE_ENV stays unset until after the install, or pnpm would skip those build tools.
RUN pnpm install --frozen-lockfile --filter sentryops --filter "@sentryops/api..." --filter "@sentryops/web..." \
 && pnpm --filter @sentryops/web build \
 && chown -R node:node apps/web/.next

ENV NODE_ENV=production
USER node
EXPOSE 3000 4000
CMD ["node", "apps/api/src/main.ts"]
