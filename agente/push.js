// Agente: corre en tu PC (dentro de la red). Lee Kairos y sube los datos ya resumidos a Neon (tabla bg_snapshot).
// La web en Vercel solo lee esa tabla; nunca toca Kairos.
require('../env');
const { Pool } = require('pg');
const k = require('../kairos');

const neon = new Pool({ connectionString: process.env.NEON_URL, ssl: { rejectUnauthorized: false }, max: 1 });
const INTERVALO = (+process.env.INTERVALO_SEG || 120) * 1000;
const ANIO = 2026;
const pad = (n) => String(n).padStart(2, '0');
const fmtLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' });
const hora = () => new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima' });

async function subir(clave, datos) {
  await neon.query(
    `INSERT INTO bg_snapshot (clave, datos, actualizado) VALUES ($1, $2, now())
     ON CONFLICT (clave) DO UPDATE SET datos = EXCLUDED.datos, actualizado = now()`, [clave, JSON.stringify(datos)]);
}

async function ciclo(todo) {
  const mesActual = +fmtLima.format(new Date()).slice(5, 7);
  const meses = todo ? Array.from({ length: mesActual }, (_, i) => i + 1) : [mesActual - 1, mesActual].filter((m) => m >= 1);
  for (const m of meses) {
    const c = `${ANIO}-${pad(m)}`;
    await subir(`ventas-${c}`, await k.ventasMes(ANIO, m));
    await subir(`laser-${c}`, await k.laserMes(ANIO, m));
    await subir(`detalle-${c}`, await k.paquetesDetalle(ANIO, m));
  }
  await subir('estado', { meses });
  console.log(`[${hora()}] OK -> meses ${meses.join(', ')}`);
}

(async () => {
  await neon.query(`CREATE TABLE IF NOT EXISTS bg_snapshot (
    clave text PRIMARY KEY, datos jsonb NOT NULL, actualizado timestamptz NOT NULL DEFAULT now())`);
  let primera = true;
  const vuelta = async () => {
    try { await ciclo(primera); primera = false; } catch (e) { console.error(`[${hora()}] FALLO: ${e.message}`); }
    setTimeout(vuelta, INTERVALO);
  };
  vuelta();
})();
