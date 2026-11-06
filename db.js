// Conexión a Neon (Postgres en la nube). Es lo único que ve la web en Vercel.
require('./env');
const { Pool } = require('pg');

if (!process.env.NEON_URL) console.error('Falta la variable NEON_URL');
// En Vercel la función se congela entre peticiones: una conexión inactiva puede quedar muerta y colgar la siguiente consulta.
// Por eso se cierran rápido y todo tiene tiempo límite (así un fallo sale como mensaje y no como pantalla de error de Vercel).
const neon = new Pool({
  connectionString: process.env.NEON_URL, ssl: { rejectUnauthorized: false },
  max: 2, idleTimeoutMillis: 1000, allowExitOnIdle: true,
  connectionTimeoutMillis: 6000, query_timeout: 8000, keepAlive: true,
});
neon.on('error', (e) => console.error('Neon:', e.message)); // una conexión caída no debe tumbar la función

module.exports = { neon };
