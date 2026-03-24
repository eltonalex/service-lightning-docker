'use strict';

const express     = require('express');
const cors        = require('cors');
const morgan      = require('morgan');
const compression = require('compression');
const path        = require('path');

const clustersRouter                    = require('./routes/clusters');
const { requestLogger }                 = require('./middleware/logger');
const { loadAllFiles, getStats, REFRESH_INTERVAL_MS } = require('./services/dataService');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ─── Middlewares ─────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));
app.use(requestLogger);

// ─── Static (dashboard HTML) ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Rotas da API ────────────────────────────────────────────────────────────
app.use('/api/clusters', clustersRouter);

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const stats = getStats();
  res.json({
    status   : 'ok',
    uptime_s : Math.floor(process.uptime()),
    data     : stats,
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 catch-all ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada', path: req.path });
});

// ─── Error handler ───────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Erro interno', message: err.message });
});

// ─── Atualização periódica ───────────────────────────────────────────────────

/**
 * Dispara um refresh silencioso. Erros são logados mas não derrubam o serviço:
 * o cache anterior continua servindo até a próxima tentativa bem-sucedida.
 */
async function scheduleRefresh() {
  try {
    const { totalFiles, totalFeatures } = await loadAllFiles();
    console.log(`[REFRESH] OK — ${totalFiles} arquivo(s), ${totalFeatures} clusters`);
  } catch (err) {
    console.error('[REFRESH] Falha (cache anterior mantido):', err.message);
  }
}

// ─── Inicialização ───────────────────────────────────────────────────────────

loadAllFiles()
  .then(({ totalFiles, totalFeatures }) => {
    console.log(`[DATA] Carga inicial: ${totalFiles} arquivo(s) — ${totalFeatures} clusters indexados`);

    // Atualização automática a cada REFRESH_INTERVAL_MS (padrão: 5 min)
    const timer = setInterval(scheduleRefresh, REFRESH_INTERVAL_MS);
    timer.unref(); // não impede o processo de encerrar normalmente

    console.log(`[DATA] Refresh automático configurado a cada ${REFRESH_INTERVAL_MS / 1000}s`);

    app.listen(PORT, HOST, () => {
      console.log(`[SERVER] lightning-glm-service rodando em http://${HOST}:${PORT}`);
      console.log(`[SERVER] Dashboard: http://localhost:${PORT}`);
      console.log(`[SERVER] API:       http://localhost:${PORT}/api/clusters`);
      console.log(`[SERVER] Health:    http://localhost:${PORT}/health`);
    });
  })
  .catch((err) => {
    console.error('[FATAL] Falha na carga inicial dos dados:', err.message);
    process.exit(1);
  });