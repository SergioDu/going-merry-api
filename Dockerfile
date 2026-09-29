FROM node:24-alpine AS build

WORKDIR /app

RUN corepack enable

# pnpm-workspace.yaml libera o build do esbuild; sem ele o pnpm 11 recusa o install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Só as dependências de produção seguem para a imagem final.
RUN pnpm prune --prod

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 3020

CMD ["node", "./dist/main.js"]
