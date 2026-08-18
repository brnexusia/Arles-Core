FROM node:22-alpine AS build

WORKDIR /app

# Use the committed lockfile so production installs are reproducible.
COPY package.json package-lock.json ./
RUN npm ci

# Production build only needs application sources and migrations.
# Tests remain available to CI/local development but must not block image creation.
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations

EXPOSE 3000

CMD ["npm", "start"]
