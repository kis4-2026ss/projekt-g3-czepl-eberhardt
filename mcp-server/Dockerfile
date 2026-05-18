FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
