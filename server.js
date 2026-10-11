require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool, types } = require('pg');

// Faz o driver do Postgres devolver colunas do tipo DATE como texto puro (ex: "2026-08-30"),
// em vez de converter para um objeto Date com fuso horário (o que gerava datas erradas
// e "NaN dias restantes" no aplicativo).
types.setTypeParser(1082, (val) => val);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Tabelas do módulo "Depósito Agromania" (itens da Vila Valentim guardados no depósito da Agromania).
// Ficam aqui no próprio server.js para que basta atualizar este arquivo no GitHub.
const SQL_DEPOSITO = `
CREATE TABLE IF NOT EXISTS deposito_itens (
  id SERIAL PRIMARY KEY,
  store TEXT NOT NULL,               -- dona do item (hoje: 'vilavalentim')
  codigo TEXT,                       -- código do produto no catálogo, quando houver
  descricao TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'Produto',  -- Produto, Cesta, Embalagem, Outro
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposito_itens_desc ON deposito_itens(store, lower(descricao));

CREATE TABLE IF NOT EXISTS deposito_movs (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES deposito_itens(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada','saida')),  -- entrada = levado ao depósito; saida = retornou à loja
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  usuario TEXT,
  obs TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deposito_movs_item ON deposito_movs(item_id);
`;

async function garantirTabelas() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  await pool.query(SQL_DEPOSITO);
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

// Edita um produto existente — permite trocar código, descrição, marca e estoque.
// Se o código mudar, os lotes já cadastrados para o código antigo são movidos junto.
app.put('/api/:store/products/:codigo', requireApiKey, requireStore, async (req, res) => {
  const store = req.params.store;
  const codigoAtual = req.params.codigo;
  const { codigo: novoCodigo, descricao, marca, estoque } = req.body;
  if (!novoCodigo || !descricao) return res.status(400).json({ error: 'codigo e descricao são obrigatórios.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (novoCodigo !== codigoAtual) {
      const { rowCount } = await client.query('SELECT 1 FROM products WHERE store=$1 AND codigo=$2', [store, novoCodigo]);
      if (rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Já existe um produto com esse código.' });
      }
    }
    await client.query(
      `UPDATE products SET codigo=$1, descricao=$2, marca=$3, estoque=$4, updated_at=now() WHERE store=$5 AND codigo=$6`,
      [novoCodigo, descricao, marca || null, estoque ?? null, store, codigoAtual]
    );
    if (novoCodigo !== codigoAtual) {
      await client.query('UPDATE lotes SET codigo=$1 WHERE store=$2 AND codigo=$3', [novoCodigo, store, codigoAtual]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Falha ao editar produto.' });
  } finally {
    client.release();
  }
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

// --- Depósito Agromania ---------------------------------------------------------
// Controle do que a loja (ex: Vila Valentim) guardou no depósito da Agromania.
// Saldo = soma das entradas (levado ao depósito) - soma das saídas (voltou para a loja).

const CATEGORIAS_DEPOSITO = ['Produto', 'Cesta', 'Embalagem', 'Outro'];

function inteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function saldoItem(client, itemId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade ELSE -quantidade END),0)::int AS saldo
     FROM deposito_movs WHERE item_id=$1`, [itemId]);
  return rows[0].saldo;
}

// Lista os itens com saldo atual
app.get('/api/:store/deposito', requireApiKey, requireStore, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.codigo, i.descricao, i.categoria,
            COALESCE(SUM(CASE WHEN m.tipo='entrada' THEN m.quantidade ELSE -m.quantidade END),0)::int AS saldo,
            MAX(m.created_at) AS ultima_mov
     FROM deposito_itens i
     LEFT JOIN deposito_movs m ON m.item_id = i.id
     WHERE i.store = $1
     GROUP BY i.id
     ORDER BY i.descricao`,
    [req.params.store]
  );
  res.json(rows);
});

// Últimas movimentações (para o histórico)
app.get('/api/:store/deposito/movs', requireApiKey, requireStore, async (req, res) => {
  const limite = Math.min(Number(req.query.limit) || 100, 500);
  const params = [req.params.store, limite];
  let filtroItem = '';
  if (req.query.item_id) { params.push(Number(req.query.item_id)); filtroItem = ' AND i.id = $3'; }
  const { rows } = await pool.query(
    `SELECT m.id, m.item_id, m.tipo, m.quantidade, m.usuario, m.obs, m.created_at,
            i.descricao, i.categoria
     FROM deposito_movs m JOIN deposito_itens i ON i.id = m.item_id
     WHERE i.store = $1${filtroItem}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $2`,
    params
  );
  res.json(rows);
});

// Levar itens para o depósito (cria o item se ainda não existir)
// Body: { item_id? , codigo?, descricao, categoria, quantidade, usuario, obs }
app.post('/api/:store/deposito/entrada', requireApiKey, requireStore, async (req, res) => {
  const store = req.params.store;
  const quantidade = inteiroPositivo(req.body.quantidade);
  const descricao = (req.body.descricao || '').toString().trim();
  const categoria = CATEGORIAS_DEPOSITO.includes(req.body.categoria) ? req.body.categoria : 'Produto';
  const codigo = (req.body.codigo || '').toString().trim() || null;
  if (!quantidade) return res.status(400).json({ error: 'Informe uma quantidade inteira maior que zero.' });
  if (!req.body.item_id && !descricao) return res.status(400).json({ error: 'Informe o item.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let itemId = Number(req.body.item_id) || null;
    if (itemId) {
      const { rowCount } = await client.query('SELECT 1 FROM deposito_itens WHERE id=$1 AND store=$2', [itemId, store]);
      if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item não encontrado.' }); }
    } else {
      const existente = await client.query(
        'SELECT id FROM deposito_itens WHERE store=$1 AND lower(descricao)=lower($2)', [store, descricao]);
      if (existente.rowCount) {
        itemId = existente.rows[0].id;
      } else {
        const novo = await client.query(
          'INSERT INTO deposito_itens (store, codigo, descricao, categoria) VALUES ($1,$2,$3,$4) RETURNING id',
          [store, codigo, descricao, categoria]);
        itemId = novo.rows[0].id;
      }
    }
    await client.query(
      `INSERT INTO deposito_movs (item_id, tipo, quantidade, usuario, obs) VALUES ($1,'entrada',$2,$3,$4)`,
      [itemId, quantidade, req.body.usuario || null, (req.body.obs || '').toString().trim() || null]);
    const saldo = await saldoItem(client, itemId);
    await client.query('COMMIT');
    res.json({ ok: true, item_id: itemId, saldo });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Falha ao registrar a entrada no depósito.' });
  } finally {
    client.release();
  }
});

// Dar baixa: itens que voltaram do depósito para a loja
// Body: { quantidade, usuario, obs }
app.post('/api/:store/deposito/:id/saida', requireApiKey, requireStore, async (req, res) => {
  const store = req.params.store;
  const itemId = Number(req.params.id);
  const quantidade = inteiroPositivo(req.body.quantidade);
  if (!quantidade) return res.status(400).json({ error: 'Informe uma quantidade inteira maior que zero.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Trava o item para que duas baixas ao mesmo tempo não deixem o saldo negativo
    const { rowCount } = await client.query('SELECT 1 FROM deposito_itens WHERE id=$1 AND store=$2 FOR UPDATE', [itemId, store]);
    if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item não encontrado.' }); }
    const saldoAtual = await saldoItem(client, itemId);
    if (quantidade > saldoAtual) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Só há ${saldoAtual} no depósito para esse item.` });
    }
    await client.query(
      `INSERT INTO deposito_movs (item_id, tipo, quantidade, usuario, obs) VALUES ($1,'saida',$2,$3,$4)`,
      [itemId, quantidade, req.body.usuario || null, (req.body.obs || '').toString().trim() || null]);
    await client.query('COMMIT');
    res.json({ ok: true, saldo: saldoAtual - quantidade });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Falha ao dar baixa no depósito.' });
  } finally {
    client.release();
  }
});

// Excluir um item (só quando o saldo estiver zerado — serve para corrigir cadastros errados)
app.delete('/api/:store/deposito/:id', requireApiKey, requireStore, async (req, res) => {
  const store = req.params.store;
  const itemId = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query('SELECT 1 FROM deposito_itens WHERE id=$1 AND store=$2 FOR UPDATE', [itemId, store]);
    if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item não encontrado.' }); }
    const saldo = await saldoItem(client, itemId);
    if (saldo !== 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Só é possível excluir itens com saldo zero. Dê baixa antes.' });
    }
    await client.query('DELETE FROM deposito_itens WHERE id=$1', [itemId]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Falha ao excluir o item.' });
  } finally {
    client.release();
  }
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
