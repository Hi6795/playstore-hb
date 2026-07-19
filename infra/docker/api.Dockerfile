FROM node:24.14.0-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.node.json ./
COPY core ./core
COPY apps/catalog-api ./apps/catalog-api
COPY tools ./tools
RUN pnpm install --frozen-lockfile --prod=false && pnpm build:server
FROM node:24.14.0-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/node ./dist/node
USER node
EXPOSE 8080
CMD ["node", "dist/node/apps/catalog-api/src/server.js"]
