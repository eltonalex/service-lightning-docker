'use strict';

const fs   = require('fs');
const path = require('path');

// Diretório de dados — sobrescrito pela variável DATA_DIR no Docker
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

// Cache em memória
let _clusters   = [];   // todos os clusters de todos os snapshots
let _timestamps = [];   // lista de timestamps únicos ordenados
let _byTs       = {};   // índice: { "2025-12-13 10:40:00": [...clusters] }
let _loadedAt   = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Calcula o centróide (média simples) dos vértices do polígono exterior.
 */
function centroid(coordinates) {
  const ring = coordinates[0];
  const n    = ring.length;
  let lon = 0, lat = 0;
  for (const [x, y] of ring) { lon += x; lat += y; }
  return { lon: +(lon / n).toFixed(4), lat: +(lat / n).toFixed(4) };
}

/**
 * Converte uma feature GeoJSON + metadados do arquivo em objeto interno.
 */
function parseFeature(feature, sourceFile) {
  const { properties: p, geometry } = feature;
  const { lon, lat } = centroid(geometry.coordinates);

  return {
    id        : p.name,
    timestamp : p.timestamp,
    event     : p.event,
    count     : p.count,
    mean      : p.mean,
    min       : p.min,
    std       : p.std,
    info      : p.info,         // nível de intensidade 1–5
    centroid  : { lon, lat },
    geometry,                   // polígono original completo
    _source   : sourceFile,
  };
}

// ─── Carregamento ────────────────────────────────────────────────────────────

/**
 * Lê todos os arquivos fig_diag_merge_*.json do DATA_DIR,
 * parseia e indexa em memória.
 */
async function loadAllFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`Diretório de dados não encontrado: ${DATA_DIR}`);
  }

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('fig_diag_merge_') && f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    throw new Error(`Nenhum arquivo fig_diag_merge_*.json encontrado em ${DATA_DIR}`);
  }

  const allClusters = [];

  for (const file of files) {
    const fullPath = path.join(DATA_DIR, file);
    const raw      = fs.readFileSync(fullPath, 'utf8');
    const geojson  = JSON.parse(raw);

    if (geojson.type !== 'FeatureCollection') {
      console.warn(`[DATA] Ignorando ${file}: não é FeatureCollection`);
      continue;
    }

    for (const feature of geojson.features) {
      allClusters.push(parseFeature(feature, file));
    }

    console.log(`[DATA] Carregado: ${file} (${geojson.features.length} clusters)`);
  }

  // Indexar por timestamp
  _clusters   = allClusters;
  _timestamps = [...new Set(allClusters.map(c => c.timestamp))].sort();
  _byTs       = {};
  for (const ts of _timestamps) {
    _byTs[ts] = allClusters.filter(c => c.timestamp === ts);
  }
  _loadedAt = new Date().toISOString();

  return { totalFiles: files.length, totalFeatures: allClusters.length };
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

/** Retorna todos os clusters, com filtros opcionais. */
function getClusters({ ts, minInfo, minCount, limit, offset } = {}) {
  let result = _clusters;

  if (ts)       result = result.filter(c => c.timestamp === ts);
  if (minInfo)  result = result.filter(c => c.info  >= Number(minInfo));
  if (minCount) result = result.filter(c => c.count >= Number(minCount));

  const total = result.length;

  if (offset) result = result.slice(Number(offset));
  if (limit)  result = result.slice(0, Number(limit));

  return { total, clusters: result };
}

/** Retorna a lista de timestamps disponíveis. */
function getTimestamps() {
  return _timestamps;
}

/** Retorna estatísticas agregadas por timestamp. */
function getSnapshotStats() {
  return _timestamps.map(ts => {
    const feats = _byTs[ts];
    const counts = feats.map(f => f.count);
    const totalRaios = counts.reduce((s, n) => s + n, 0);
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    feats.forEach(f => { dist[f.info] = (dist[f.info] || 0) + 1; });

    return {
      timestamp       : ts,
      clusters        : feats.length,
      total_raios     : totalRaios,
      avg_raios_cluster: +(totalRaios / feats.length).toFixed(2),
      max_count       : Math.max(...counts),
      info_distribution: dist,
    };
  });
}

/** Retorna os N clusters com maior count (mais raios). */
function getTopClusters(n = 15) {
  return [..._clusters]
    .sort((a, b) => b.count - a.count || b.info - a.info)
    .slice(0, Number(n));
}

/** Retorna estatísticas globais (para /health e header do dashboard). */
function getStats() {
  if (!_clusters.length) return { loaded: false };
  const total_raios = _clusters.reduce((s, c) => s + c.count, 0);
  return {
    loaded           : true,
    loaded_at        : _loadedAt,
    total_clusters   : _clusters.length,
    total_snapshots  : _timestamps.length,
    total_raios,
    timestamps_range : {
      first: _timestamps[0],
      last : _timestamps[_timestamps.length - 1],
    },
  };
}

module.exports = {
  loadAllFiles,
  getClusters,
  getTimestamps,
  getSnapshotStats,
  getTopClusters,
  getStats,
};
