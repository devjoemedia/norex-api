# Prisma's query engine links against OpenSSL, which Alpine doesn't ship. Install it in
# BOTH stages: at build time so `prisma generate` picks the openssl-3 engine, and at
# runtime so that engine can load (otherwise: "libssl.so.1.1: No such file").

# --- build ---
FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

# --- runtime (non-root, minimal) ---
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma
USER node
EXPOSE 3001
CMD ["node", "dist/src/main"]
