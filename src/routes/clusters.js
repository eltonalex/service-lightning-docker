'use strict';

const express = require('express');
const router  = express.Router();
const ds      = require('../services/dataService');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clusters/snapshots
// Lista todos os timestamps disponíveis nos arquivos carregados.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/snapshots', (req, res) => {
  const timestamps = ds.getTimestamps();
  res.json({
    count     : timestamps.length,
    timestamps,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clusters/stats
// Retorna estatísticas agregadas por snapshot (clusters, raios, distribuição info).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const stats = ds.getSnapshotStats();
  res.json({ count: stats.length, snapshots: stats });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clusters/top
// Query params:
//   n=15       — quantos clusters retornar (default 15)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/top', (req, res) => {
  const n   = Math.min(parseInt(req.query.n) || 15, 100);
  const top = ds.getTopClusters(n);
  res.json({ count: top.length, clusters: top });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clusters
// Lista todos os clusters com filtros opcionais.
//
// Query params:
//   ts=<timestamp>   — filtrar por timestamp exato ex: "2025-12-13 10:40:00"
//   min_info=<1–5>   — nível mínimo de intensidade
//   min_count=<n>    — mínimo de raios no cluster
//   limit=<n>        — paginação (default 200, max 1000)
//   offset=<n>       — paginação offset
//   geometry=false   — omitir polígonos GeoJSON para resposta menor
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { ts, min_info, min_count, geometry = 'true' } = req.query;
  const limit  = Math.min(parseInt(req.query.limit)  || 200, 1000);
  const offset = parseInt(req.query.offset) || 0;

  const { total, clusters } = ds.getClusters({
    ts,
    minInfo : min_info,
    minCount: min_count,
    limit,
    offset,
  });

  const includeGeometry = geometry !== 'false';
  const payload = includeGeometry
    ? clusters
    : clusters.map(({ geometry: _g, ...rest }) => rest); // eslint-disable-line no-unused-vars

  res.json({
    total,
    returned : payload.length,
    offset,
    limit,
    clusters : payload,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clusters/geojson
// Retorna os clusters do snapshot solicitado como FeatureCollection GeoJSON
// pronta para consumo direto por flutter_map / Leaflet / Mapbox.
//
// Query params:
//   ts=<timestamp>  (obrigatório)
//   min_info=<1–5>  (opcional)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/geojson', (req, res) => {
  const { ts, min_info } = req.query;

  if (!ts) {
    return res.status(400).json({
      error  : 'Parâmetro obrigatório ausente',
      detail : 'Informe o parâmetro ts=<timestamp>, ex: ?ts=2025-12-13 10:40:00',
      available: ds.getTimestamps(),
    });
  }

  const { clusters } = ds.getClusters({ ts, minInfo: min_info, limit: 1000 });

  if (clusters.length === 0) {
    return res.status(404).json({ error: 'Nenhum cluster encontrado para este timestamp', ts });
  }

  const featureCollection = {
    type: 'FeatureCollection',
    crs : { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    metadata: {
      timestamp: ts,
      source   : 'lightning-glm-service',
      clusters : clusters.length,
    },
    features: clusters.map(c => ({
      type      : 'Feature',
      properties: {
        id   : c.id,
        timestamp: c.timestamp,
        event: c.event,
        count: c.count,
        mean : c.mean,
        min  : c.min,
        std  : c.std,
        info : c.info,
        centroid: c.centroid,
      },
      geometry: c.geometry,
    })),
  };

  res.setHeader('Content-Type', 'application/geo+json');
  res.json(featureCollection);
});

module.exports = router;
