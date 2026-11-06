// Consultas al ERP Kairos. Solo las usa el agente (agente/push.js), que corre dentro de tu red.
// La web en Vercel NO toca Kairos: lee lo que el agente deja en Neon.
require('./env');
const { Pool } = require('pg');

const kairos = new Pool({
  host: process.env.KAIROS_HOST, port: +(process.env.KAIROS_PORT || 5432),
  database: process.env.KAIROS_DB || 'erp_kairos', user: process.env.KAIROS_USER, password: process.env.KAIROS_PASSWORD,
  max: 2, connectionTimeoutMillis: 8000,
});
const pad = (n) => String(n).padStart(2, '0');

// Paquetes de 6 sesiones.
//  L = láser de fisioterapia: LASERTERAPIA P6 + INDOMETACINA (fascitis, juanete, metatarso, talón, tríceps sural)
//  F = fisioterapia en paquete de 6: FISIOTERAPIA P6
const PATRON_L = '%LASERTERAPIA P6 + INDOMETACINA%';
const PATRON_F = '%FISIOTERAPIA P6%';

// Ventas por día y sede del mes (con IGV, comprobantes no anulados, sin duplicar comprobantes): dia -> cod -> monto
async function ventasMes(anio, mes) {
  const desde = `${anio}-${pad(mes)}-01`;
  const r = await kairos.query(
    `SELECT dia, c_u_negocio AS cod, SUM(tot_venta) AS monto FROM (
       SELECT DISTINCT ON (v.c_u_negocio, v.ndocumento_cpe, v.f_emision)
              to_char(v.f_emision,'YYYY-MM-DD') AS dia, v.c_u_negocio, v.tot_venta
       FROM modelo.venta_registro v
       WHERE v.s_anulado = 0 AND v.f_emision >= $1::date AND v.f_emision < ($1::date + interval '1 month')
     ) x GROUP BY dia, c_u_negocio`, [desde]);
  const mapa = {};
  for (const x of r.rows) (mapa[x.dia] || (mapa[x.dia] = {}))[x.cod] = Number(x.monto);
  return mapa;
}

// Sesiones vendidas por día y sede: dia -> cod -> { L, F }
async function laserMes(anio, mes) {
  const desde = `${anio}-${pad(mes)}-01`;
  const r = await kairos.query(
    `SELECT to_char(v.f_emision,'YYYY-MM-DD') AS dia, v.c_u_negocio AS cod,
            CASE WHEN upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $2 THEN 'L' ELSE 'F' END AS tipo, SUM(i.cantidad) AS cant
     FROM modelo.venta_registro_item i
     JOIN modelo.venta_registro v ON v.c_empresa=i.c_empresa AND v.c_u_negocio=i.c_u_negocio AND v.anomes=i.anomes AND v.ndocumento_cpe=i.ndocumento_cpe
     LEFT JOIN modelo.m_producto_bs p ON p.c_empresa=i.c_empresa AND p.c_producto_bs=i.c_producto_bs
     WHERE i.s_anulado=0 AND v.s_anulado=0 AND v.f_emision >= $1::date AND v.f_emision < ($1::date + interval '1 month')
       AND (upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $2 OR upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $3)
     GROUP BY 1,2,3`, [desde, PATRON_L, PATRON_F]);
  const mapa = {};
  for (const x of r.rows) ((mapa[x.dia] || (mapa[x.dia] = {}))[x.cod] || (mapa[x.dia][x.cod] = {}))[x.tipo] = Number(x.cant);
  return mapa;
}

// Detalle de cada venta de los paquetes: fecha, sede (cod), producto, tipo, cantidad, importe y comprobante.
async function paquetesDetalle(anio, mes) {
  const desde = `${anio}-${pad(mes)}-01`;
  const r = await kairos.query(
    `SELECT to_char(v.f_emision,'YYYY-MM-DD') AS fecha, v.c_u_negocio AS cod,
            upper(trim(coalesce(p.d_producto_bs, i.glosa, ''))) AS producto,
            CASE WHEN upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $2 THEN 'L' ELSE 'F' END AS tipo,
            i.cantidad AS cant, i.tot_venta_item AS monto,
            coalesce(v.s_cpe::text,'') || '-' || coalesce(v.n_cpe::text,'') AS doc
     FROM modelo.venta_registro_item i
     JOIN modelo.venta_registro v ON v.c_empresa=i.c_empresa AND v.c_u_negocio=i.c_u_negocio AND v.anomes=i.anomes AND v.ndocumento_cpe=i.ndocumento_cpe
     LEFT JOIN modelo.m_producto_bs p ON p.c_empresa=i.c_empresa AND p.c_producto_bs=i.c_producto_bs
     WHERE i.s_anulado=0 AND v.s_anulado=0 AND v.f_emision >= $1::date AND v.f_emision < ($1::date + interval '1 month')
       AND (upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $2 OR upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $3)
     ORDER BY v.f_emision DESC, v.ndocumento_cpe DESC`, [desde, PATRON_L, PATRON_F]);
  return r.rows.map((x) => ({ ...x, cant: Number(x.cant), monto: Number(x.monto) }));
}

module.exports = { ventasMes, laserMes, paquetesDetalle, cerrar: () => kairos.end() };
