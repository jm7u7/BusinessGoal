// Conexión a Neon (Postgres en la nube). Es lo único que ve la web en Vercel.
require('./env');
const { Pool } = require('pg');

if (!process.env.NEON_URL) console.error('Falta la variable NEON_URL');
const neon = new Pool({ connectionString: process.env.NEON_URL, ssl: { rejectUnauthorized: false }, max: 2 });

module.exports = { neon };
