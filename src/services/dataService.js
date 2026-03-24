'use strict';

const https = require('https');

// ─── Configuração ────────────────────────────────────────────────────────────

// URL base do diretório mensal. Suporta sobrescrita por variável de ambiente.
// Exemplo: RAIOS_BASE_URL=https://ftp.cptec.inpe.br/nowcasting/RAIOS/2026/03/
// Se não definida, o caminho é calculado dinamicamente pela data UTC atual.
const RAIOS_BASE_URL = process.env.RAIOS_BASE_URL || null;

// Quantos arquivos (snapshots) manter em memória (1 arquivo = 5 min).
// Padrão: 12 arquivos = 1 hora de histórico.
const SNAPSHOT_WINDOW = parseInt(process.env.SNAPSHOT_WINDOW) || 12;

// Intervalo de atualização automática em milissegundos (padrão: 5 min).
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS) || 5 * 60 * 1000;

// ─── Cache em memória ────────────────────────────────────────────────────────

let _clusters    = [];
let _timestamps  = [];
let _byTs        = {};
let _loadedAt    = null;
let _loadedFiles = [];   // nomes dos arquivos atualmente em cache

// ─── Helpers HTTP ────────────────────────────────────────────────────────────

/**
 * Faz GET em uma URL HTTPS e retorna o corpo como string.
 * Usa Connection: close para evitar keep-alive que pode causar
 * drops nos servidores do INPE em arquivos grandes.
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Connection: 'close' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ao buscar ${url}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end',  ()    => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`Timeout: ${url}`)));
  });
}

// ─── URL do diretório ────────────────────────────────────────────────────────

/**
 * Retorna a URL do diretório mensal baseado na data UTC atual.
 * Exemplo: https://ftp.cptec.inpe.br/nowcasting/RAIOS/2026/03/
 */
function buildDirectoryUrl(date = new Date()) {
  if (RAIOS_BASE_URL) {
    return RAIOS_BASE_URL.endsWith('/') ? RAIOS_BASE_URL : RAIOS_BASE_URL + '/';
  }
  const year  = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `https://ftp.cptec.inpe.br/nowcasting/RAIOS/${year}/${month}/`;
}

/**
 * Faz o listing HTML do diretório e extrai nomes dos arquivos RAIOS_*.json.
 * O servidor FTP-over-HTTP do CPTEC retorna links no formato:
 *   <a href="RAIOS_202603241820.json">RAIOS_202603241820.json</a>
 * Retorna array ordenado cronologicamente (ordenação léxica = cronológica).
 */
async function listRemoteFiles(dirUrl) {
  const html    = await httpGet(dirUrl);
  const pattern = /href="(RAIOS_\d{12}\.json)"/gi;
  const files   = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    files.push(match[1]);
  }
  return files.sort();
}

// ─── Parse de features ───────────────────────────────────────────────────────

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
 * Converte uma feature GeoJSON em objeto interno.
 * Compatível com o schema dos arquivos RAIOS_*.json.
 * Propriedades: name, timestamp, event, count, mean, min, std, info.
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
    info      : p.info,       // nível de intensidade 1–5
    centroid  : { lon, lat },
    geometry,                 // polígono original completo
    _source   : sourceFile,
  };
}

// ─── Carregamento / Refresh ───────────────────────────────────────────────────

/**
 * Busca e parseia um único arquivo RAIOS remoto.
 * Retorna array de clusters, ou [] em caso de erro não-fatal.
 */
async function fetchFile(dirUrl, filename) {
  const url = dirUrl + filename;
  try {
    const raw     = await httpGet(url);
    const geojson = JSON.parse(raw);

    if (geojson.type !== 'FeatureCollection') {
      console.warn(`[DATA] Ignorando ${filename}: não é FeatureCollection`);
      return [];
    }

    const clusters = geojson.features.map(f => parseFeature(f, filename));
    console.log(`[DATA] Carregado: ${filename} (${clusters.length} clusters)`);
    return clusters;
  } catch (err) {
    console.error(`[DATA] Falha ao buscar ${filename}: ${err.message}`);
    return [];
  }
}

/**
 * Carrega (ou atualiza) os últimos SNAPSHOT_WINDOW arquivos do diretório remoto.
 *
 * - Primeiro acesso: full-load de todos os arquivos da janela.
 * - Atualizações seguintes: busca apenas arquivos novos, descarta os mais antigos
 *   para manter o tamanho da janela estável.
 *
 * Interface de retorno idêntica à versão anterior baseada em disco.
 */
async function loadAllFiles() {
  const dirUrl   = buildDirectoryUrl();
  console.log(`[DATA] Buscando listing em: ${dirUrl}`);

  const allFiles = await listRemoteFiles(dirUrl);
  const window   = allFiles.slice(-SNAPSHOT_WINDOW);

  if (window.length === 0) {
    throw new Error(`Nenhum arquivo RAIOS_*.json encontrado em ${dirUrl}`);
  }

  // Quais arquivos ainda não estão em cache?
  const cachedSet = new Set(_loadedFiles);
  const newFiles  = window.filter(f => !cachedSet.has(f));

  if (newFiles.length === 0) {
    console.log('[DATA] Cache já está atualizado, nenhum arquivo novo.');
    return { totalFiles: _loadedFiles.length, totalFeatures: _clusters.length };
  }

  // Buscar novos arquivos em paralelo
  const newClusters = (
    await Promise.all(newFiles.map(f => fetchFile(dirUrl, f)))
  ).flat();

  // Mesclar com cache e manter apenas os arquivos da janela atual
  const keepSet    = new Set(window);
  const merged     = [..._clusters, ...newClusters].filter(c => keepSet.has(c._source));

  // Remontar índices
  _clusters   = merged;
  _timestamps = [...new Set(merged.map(c => c.timestamp))].sort();
  _byTs       = {};
  for (const ts of _timestamps) {
    _byTs[ts] = merged.filter(c => c.timestamp === ts);
  }
  _loadedFiles = window;
  _loadedAt    = new Date().toISOString();

  console.log(
    `[DATA] Cache atualizado: ${window.length} arquivo(s) — ` +
    `${merged.length} clusters — ` +
    `janela: ${_timestamps[0]} → ${_timestamps[_timestamps.length - 1]}`
  );

  return { totalFiles: window.length, totalFeatures: merged.length };
}

// ─── Leitura (interface pública — idêntica à versão anterior) ─────────────────

/** Retorna todos os clusters com filtros opcionais. */
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

/** Retorna estatísticas agregadas por snapshot. */
function getSnapshotStats() {
  return _timestamps.map(ts => {
    const feats      = _byTs[ts];
    const counts     = feats.map(f => f.count);
    const totalRaios = counts.reduce((s, n) => s + n, 0);
    const dist       = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    feats.forEach(f => { dist[f.info] = (dist[f.info] || 0) + 1; });

    return {
      timestamp        : ts,
      clusters         : feats.length,
      total_raios      : totalRaios,
      avg_raios_cluster: +(totalRaios / feats.length).toFixed(2),
      max_count        : Math.max(...counts),
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

/** Retorna estatísticas globais (para /health e dashboard). */
function getStats() {
  if (!_clusters.length) return { loaded: false };
  const total_raios = _clusters.reduce((s, c) => s + c.count, 0);
  return {
    loaded           : true,
    loaded_at        : _loadedAt,
    total_clusters   : _clusters.length,
    total_snapshots  : _timestamps.length,
    total_raios,
    source_url       : buildDirectoryUrl(),
    snapshot_window  : SNAPSHOT_WINDOW,
    loaded_files     : _loadedFiles,
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
  REFRESH_INTERVAL_MS,
};