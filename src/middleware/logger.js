'use strict';

/**
 * Middleware de log estruturado.
 * Emite uma linha JSON por requisição ao final da resposta.
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(JSON.stringify({
      time    : new Date().toISOString(),
      method  : req.method,
      path    : req.path,
      query   : req.query,
      status  : res.statusCode,
      ms,
    }));
  });

  next();
}

module.exports = { requestLogger };
