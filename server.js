require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function garantirTabelas() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Tabelas verificadas/criadas com sucesso.');
}

const STORES = ['agromania', 'vilavalentim'];
const API_KEY = process.env.API_KEY;         // usado pelo app (frontend)
const SYNC_KEY = process.env.SYNC_KEY || API_KEY; // usado pelo n8n (pode ser o mesmo ou um separado)

if (!API_KEY) {
  console.warn('AVISO: variável de ambiente API_KEY não definida. Configure-a antes de ir para produção.');
}

// --- Middlewares -----------------------------------------------------------

function requireStore(req, res, next) {
  if (!STORES.includes(req.params.store)) {
    return res.status(400).json({ error: 'Loja inválida. Use: ' + STORES.join(' ou ') });
  }
  next();
}

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'x-api-key inválida ou ausente.' });
  }
  next();
}

function requireSyncKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!SYNC_KEY || key !== SYNC_KEY) {
    return res.status(401).json({ error: 'x-api-key inválida ou ausente (rota de sincronização).' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

// --- Produtos ---------------------------------------------------------------

// Lista produtos de uma loja
app.get('/api/:store/products', requireApiKey, requireStore, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT codigo, descricao, marca, estoque FROM products WHERE store = $1 ORDER BY descricao',
    [req.params.store]
  );
  res.json(rows);
});

// Cria/atualiza um único produto (usado pelo app)
app.post('/api/:store/products', requireApiKey, requireStore, async (req, res) => {
  const { codigo, descricao, marca, estoque } = req.body;
  if (!codigo || !descricao) return res.status(400).json({ error: 'codigo e descricao são obrigatórios.' });
  await pool.query(
    `INSERT INTO products (store, codigo, descricao, marca, estoque, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (store, codigo) DO UPDATE SET
       descricao = EXCLUDED.descricao,
       marca = EXCLUDED.marca,
       estoque = COALESCE(EXCLUDED.estoque, products.estoque),
       updated_at = now()`,
    [req.params.store, codigo, descricao, marca || null, estoque ?? null]
  );
  res.json({ ok: true });
});

// Sincronização em lote — é este endpoint que o n8n chama (Magazord ou Gestão Click)
// Body esperado: { products: [ {codigo, descricao, marca, estoque}, ... ] }
app.post('/api/:store/sync/products', requireSyncKey, requireStore, async (req, res) => {
  const items = req.body.products;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Envie { products: [...] }' });
  const client = await pool.connect();
  let novos = 0, atualizados = 0;
  try {
    await client.query('BEGIN');
    for (const item of items) {
      if (!item.codigo) continue;
      const { rowCount } = await client.query('SELECT 1 FROM products WHERE store=$1 AND codigo=$2', [req.params.store, item.codigo]);
      await client.query(
        `INSERT INTO products (store, codigo, descricao, marca, estoque, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (store, codigo) DO UPDATE SET
           descricao = EXCLUDED.descricao,
           marca = EXCLUDED.marca,
           estoque = COALESCE(EXCLUDED.estoque, products.estoque),
           updated_at = now()`,
        [req.params.store, item.codigo, item.descricao || '', item.marca || null, item.estoque ?? null]
      );
      if (rowCount > 0) atualizados++; else novos++;
    }
    await client.query('COMMIT');
    res.json({ ok: true, novos, atualizados, total: items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Falha ao sincronizar produtos.' });
  } finally {
    client.release();
  }
});

app.delete('/api/:store/products/:codigo', requireApiKey, requireStore, async (req, res) => {
  await pool.query('DELETE FROM products WHERE store=$1 AND codigo=$2', [req.params.store, req.params.codigo]);
  res.json({ ok: true });
});

// --- Lotes / validades --------------------------------------------------------

app.get('/api/:store/lotes', requireApiKey, requireStore, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.codigo, l.quantidade, l.validade, l.lote, l.registrado_por,
            p.descricao, p.marca, p.estoque
     FROM lotes l
     LEFT JOIN products p ON p.store = l.store AND p.codigo = l.codigo
     WHERE l.store = $1
     ORDER BY l.validade ASC`,
    [req.params.store]
  );
  res.json(rows);
});

app.post('/api/:store/lotes', requireApiKey, requireStore, async (req, res) => {
  const { codigo, quantidade, validade, lote, registrado_por } = req.body;
  if (!codigo || !quantidade || !validade) {
    return res.status(400).json({ error: 'codigo, quantidade e validade são obrigatórios.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO lotes (store, codigo, quantidade, validade, lote, registrado_por)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.params.store, codigo, quantidade, validade, lote || null, registrado_por || null]
  );
  res.json({ ok: true, id: rows[0].id });
});

app.delete('/api/:store/lotes/:id', requireApiKey, requireStore, async (req, res) => {
  await pool.query('DELETE FROM lotes WHERE store=$1 AND id=$2', [req.params.store, req.params.id]);
  res.json({ ok: true });
});

// --- Usuários da loja ----------------------------------------------------------

app.get('/api/:store/users', requireApiKey, requireStore, async (req, res) => {
  const { rows } = await pool.query('SELECT nome FROM users WHERE store=$1 ORDER BY nome', [req.params.store]);
  res.json(rows.map(r => r.nome));
});

app.post('/api/:store/users', requireApiKey, requireStore, async (req, res) => {
  const { nome } = req.body;
  if (!nome) return res.status(400).json({ error: 'nome é obrigatório.' });
  await pool.query('INSERT INTO users (store, nome) VALUES ($1,$2) ON CONFLICT (store, nome) DO NOTHING', [req.params.store, nome]);
  res.json({ ok: true });
});

app.delete('/api/:store/users/:nome', requireApiKey, requireStore, async (req, res) => {
  await pool.query('DELETE FROM users WHERE store=$1 AND nome=$2', [req.params.store, req.params.nome]);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
garantirTabelas()
  .then(() => app.listen(PORT, () => console.log(`Controle de Validade API rodando na porta ${PORT}`)))
  .catch(err => { console.error('Falha ao preparar o banco de dados:', err); process.exit(1); });
