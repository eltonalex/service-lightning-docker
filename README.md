# ⚡ lightning-glm-service

Serviço REST em Node.js para análise e visualização de **clusters de raios GLM/DECEA**,
desenvolvido como componente de backend do projeto **SOS Chuva**.

Lê arquivos `fig_diag_merge_*.json` (FeatureCollection GeoJSON) de um diretório local
e os expõe via API REST, além de servir um dashboard interativo.

---

## Estrutura do Projeto

```
lightning-glm-service/
├── src/
│   ├── server.js               # Entry point — Express + inicialização
│   ├── routes/
│   │   └── clusters.js         # Endpoints da API
│   ├── services/
│   │   └── dataService.js      # Leitura, parsing e cache dos GeoJSONs
│   └── middleware/
│       └── logger.js           # Log estruturado por requisição
├── public/
│   └── index.html              # Dashboard interativo (servido estaticamente)
├── data/                       # Arquivos fig_diag_merge_*.json (volume Docker)
├── Dockerfile                  # Build multi-stage (deps → runtime)
├── docker-compose.yml
├── .dockerignore
└── package.json
```

---

## Rodar com Docker Compose

```bash
# 1. Coloque os arquivos GeoJSON em ./data/
cp /caminho/para/fig_diag_merge_*.json ./data/

# 2. Build + start
docker compose up --build -d

# 3. Verificar logs
docker compose logs -f

# 4. Parar
docker compose down
```

O serviço ficará disponível em **http://localhost:3000**.

---

## Rodar localmente (sem Docker)

```bash
npm install
DATA_DIR=./data node src/server.js
# ou em modo dev com hot-reload:
npm run dev
```

---

## API Reference

### `GET /health`
Retorna status do serviço e resumo dos dados carregados.

```json
{
  "status": "ok",
  "uptime_s": 42,
  "data": {
    "loaded": true,
    "total_clusters": 344,
    "total_snapshots": 7,
    "total_raios": 2179,
    "timestamps_range": {
      "first": "2025-12-13 10:40:00",
      "last":  "2025-12-13 11:10:00"
    }
  }
}
```

---

### `GET /api/clusters/snapshots`
Lista os timestamps disponíveis.

```json
{
  "count": 7,
  "timestamps": [
    "2025-12-13 10:40:00",
    "2025-12-13 10:45:00",
    ...
  ]
}
```

---

### `GET /api/clusters/stats`
Estatísticas agregadas por snapshot.

```json
{
  "count": 7,
  "snapshots": [
    {
      "timestamp": "2025-12-13 10:40:00",
      "clusters": 56,
      "total_raios": 317,
      "avg_raios_cluster": 5.66,
      "max_count": 44,
      "info_distribution": { "1": 44, "2": 7, "3": 1, "4": 2, "5": 2 }
    }
  ]
}
```

---

### `GET /api/clusters`
Lista clusters com filtros opcionais.

| Parâmetro   | Tipo   | Descrição                                    |
|-------------|--------|----------------------------------------------|
| `ts`        | string | Filtrar por timestamp exato                  |
| `min_info`  | int    | Nível mínimo de intensidade (1–5)            |
| `min_count` | int    | Quantidade mínima de raios no cluster        |
| `limit`     | int    | Máx. resultados por página (default 200)     |
| `offset`    | int    | Offset para paginação                        |
| `geometry`  | bool   | Incluir polígonos GeoJSON (default `true`)   |

**Exemplos:**
```bash
# Todos os clusters do snapshot das 10:50
GET /api/clusters?ts=2025-12-13 10:50:00

# Só clusters críticos (info >= 4), sem geometria
GET /api/clusters?min_info=4&geometry=false

# Paginação
GET /api/clusters?limit=50&offset=100
```

---

### `GET /api/clusters/top?n=15`
Os N clusters com mais raios detectados.

---

### `GET /api/clusters/geojson?ts=<timestamp>`
Retorna um snapshot completo como **FeatureCollection GeoJSON** (`Content-Type: application/geo+json`),
pronto para consumo direto pelo flutter_map.

```bash
GET /api/clusters/geojson?ts=2025-12-13 10:50:00
GET /api/clusters/geojson?ts=2025-12-13 10:50:00&min_info=3
```

---

## Variáveis de Ambiente

| Variável   | Padrão  | Descrição                                      |
|------------|---------|------------------------------------------------|
| `PORT`     | `3000`  | Porta do servidor HTTP                         |
| `HOST`     | `0.0.0.0` | Interface de escuta                          |
| `DATA_DIR` | `./data` | Diretório dos arquivos `fig_diag_merge_*.json` |
| `NODE_ENV` | `production` | Ambiente Node.js                          |

---

## Integração com Flutter (SOS Chuva)

```dart
// Buscar GeoJSON de um snapshot
final response = await http.get(
  Uri.parse('http://<host>:3000/api/clusters/geojson'
    '?ts=2025-12-13 10:50:00'),
);
final geojson = jsonDecode(response.body);

// Buscar só clusters críticos sem geometria (leve)
final stats = await http.get(
  Uri.parse('http://<host>:3000/api/clusters?min_info=4&geometry=false'),
);
```
