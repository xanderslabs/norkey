FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/server ./packages/server
RUN pnpm install --filter @norkey/server --frozen-lockfile && pnpm --filter @norkey/server build
ENV NORKEY_DB=/data/norkey.db
VOLUME /data
EXPOSE 8787
CMD ["node", "packages/server/dist/serve.js", "serve"]
