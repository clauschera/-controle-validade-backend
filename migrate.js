// Roda o schema.sql contra o banco apontado por DATABASE_URL.
// Uso: node migrate.js  (ou "npm run migrate")
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Migração concluída com sucesso.');
  await pool.end();
}

run().catch(err => {
  console.error('Erro ao migrar:', err);
  process.exit(1);
});
