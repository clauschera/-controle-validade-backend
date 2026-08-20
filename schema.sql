-- Schema do Controle de Validade
-- Execute este arquivo uma vez no banco Postgres (Railway/Render criam um automaticamente
-- e fornecem a variável de ambiente DATABASE_URL).

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  store TEXT NOT NULL,               -- 'agromania' ou 'vilavalentim'
  codigo TEXT NOT NULL,
  descricao TEXT,
  marca TEXT,
  estoque INTEGER,                   -- só relevante para vilavalentim (Gestão Click)
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(store, codigo)
);

CREATE TABLE IF NOT EXISTS lotes (
  id SERIAL PRIMARY KEY,
  store TEXT NOT NULL,
  codigo TEXT NOT NULL,
  quantidade INTEGER NOT NULL,
  validade DATE NOT NULL,
  lote TEXT,
  registrado_por TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  store TEXT NOT NULL,
  nome TEXT NOT NULL,
  UNIQUE(store, nome)
);

CREATE INDEX IF NOT EXISTS idx_lotes_store_validade ON lotes(store, validade);
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store);
