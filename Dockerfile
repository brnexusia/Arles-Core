FROM node:22-alpine AS build

WORKDIR /app

# Use the committed lockfile so production installs are reproducible.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations

# Runtime never needs root privileges.
USER node

EXPOSE 3000

CMD ["npm", "start"]
