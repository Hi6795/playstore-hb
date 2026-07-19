FROM node:24.14.0-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/admin-web ./apps/admin-web
RUN pnpm install --frozen-lockfile --prod=false && pnpm build:admin
FROM nginx:1.29.8-alpine
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/admin-web /usr/share/nginx/html
USER nginx
