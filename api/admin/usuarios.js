// Función de Vercel: atiende todo lo que empiece con /api/
const { api, json } = require('../../app');

module.exports = async (req, res) => {
  try { await api(req, res, new URL(req.url, 'http://x')); }
  catch (e) { console.error(e); json(res, 500, { error: 'Error interno: ' + e.message }); }
};
