# ─── Stage 1: dependências ───────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copia apenas os manifests para aproveitar cache de layer
COPY package*.json ./

# Instala apenas dependências de produção
RUN npm ci --omit=dev

# ─── Stage 2: imagem final ───────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Metadados
LABEL org.opencontainers.image.title="lightning-glm-service"
LABEL org.opencontainers.image.description="Serviço REST de clusters de raios GLM/DECEA — SOS Chuva"
LABEL org.opencontainers.image.version="1.0.0"

# Usuário não-root para segurança
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copia node_modules já construídos no stage anterior
COPY --from=deps /app/node_modules ./node_modules

# Copia código-fonte e assets estáticos
COPY src/    ./src/
COPY public/ ./public/
COPY package.json ./

# Diretório de dados montado externamente via volume
# Os arquivos fig_diag_merge_*.json devem ser colocados aqui
RUN mkdir -p /data && chown appuser:appgroup /data

# Ajusta ownership do app
RUN chown -R appuser:appgroup /app

USER appuser

# Variáveis de ambiente com valores padrão
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 3000

# Health check nativo do Docker
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
