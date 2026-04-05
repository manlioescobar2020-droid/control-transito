const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/control_transito',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

function mapRegistro(row) {
  if (!row) return null;
  return {
    ...row,
    patente: row.patente || row.patricula || null,
    patricula: row.patricula || row.patente || null,
    fecha_rto_vence: row.fecha_rto_vence || row.pdf_rto || null
  };
}

app.post('/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) {
    return res.status(400).json({ success: false, message: 'Faltan credenciales' });
  }
  try {
    const result = await pool.query(
      'SELECT id, usuario, nombre, rol FROM usuarios WHERE LOWER(usuario) = LOWER($1) AND password = $2 LIMIT 1',
      [usuario, password]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Error en /login:', err.message);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

app.get('/api/vehiculos/:patente', async (req, res) => {
  const patente = String(req.params.patente || '').toUpperCase().trim();
  if (!patente) return res.status(400).json({ error: 'Patente requerida' });

  try {
    const vehiculoResult = await pool.query(
      `SELECT 
         COALESCE(patricula, patente) AS patente,
         modelo,
         numero_08,
         fecha_seguro_vence,
         COALESCE(fecha_rto_vence, pdf_rto) AS fecha_rto_vence
       FROM vehiculos
       WHERE UPPER(COALESCE(patricula, patente)) = $1
       LIMIT 1`,
      [patente]
    );

    const controlResult = await pool.query(
      `SELECT *
       FROM pdf_acta
       WHERE UPPER(COALESCE(patricula, patente)) = $1
       ORDER BY fecha_hora DESC
       LIMIT 1`,
      [patente]
    );

    res.json({
      vehiculo: vehiculoResult.rows[0] || null,
      ultimoControl: mapRegistro(controlResult.rows[0])
    });
  } catch (err) {
    console.error('Error al buscar vehículo:', err.message);
    res.status(500).json({ error: 'Error al buscar vehículo' });
  }
});

app.post('/registrar-control', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      patricula,
      patente,
      modelo,
      numero_08,
      fecha_seguro_vence,
      fecha_rto_vence,
      id_inspector,
      latitud,
      longitud,
      texto_ubicacion,
      tiene_cedula,
      tiene_licencia,
      tiene_seguro,
      tiene_08_pago,
      tiene_rto_habilitada,
      observaciones,
      foto_evidencia,
      firma_conductor
    } = req.body;

    const dominio = String(patricula || patente || '').toUpperCase().trim();
    if (!dominio || !id_inspector) {
      return res.status(400).json({ success: false, message: 'Faltan datos obligatorios' });
    }

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO vehiculos (patricula, modelo, numero_08, fecha_seguro_vence, pdf_rto)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (patricula)
       DO UPDATE SET
         modelo = EXCLUDED.modelo,
         numero_08 = EXCLUDED.numero_08,
         fecha_seguro_vence = EXCLUDED.fecha_seguro_vence,
         pdf_rto = EXCLUDED.pdf_rto`,
      [dominio, modelo || null, numero_08 || null, fecha_seguro_vence || null, fecha_rto_vence || null]
    );

    const result = await client.query(
      `INSERT INTO pdf_acta (
         patricula, id_inspector, latitud, longitud, texto_ubicacion,
         tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada,
         observaciones, foto_evidencia, firma_conductor
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        dominio,
        id_inspector,
        latitud || null,
        longitud || null,
        texto_ubicacion || 'Ubicación GPS',
        !!tiene_cedula,
        !!tiene_licencia,
        !!tiene_seguro,
        !!tiene_08_pago,
        !!tiene_rto_habilitada,
        observaciones || '',
        foto_evidencia || null,
        firma_conductor || null
      ]
    );

    await client.query('COMMIT');
    io.emit('nuevo_control_registrado', result.rows[0]);
    res.json({ success: true, registro: mapRegistro(result.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en /registrar-control:', err.message);
    res.status(500).json({ success: false, message: 'Error al registrar control' });
  } finally {
    client.release();
  }
});

app.get('/api/historial', async (req, res) => {
  const limite = parseInt(req.query.limit, 10) || 100;
  try {
    const result = await pool.query(
      `SELECT id,
              COALESCE(patricula, patente) AS patricula,
              fecha_hora,
              latitud,
              longitud,
              observaciones
       FROM pdf_acta
       ORDER BY fecha_hora DESC
       LIMIT $1`,
      [limite]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener historial:', err.message);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

app.post('/api/crear-usuario', async (req, res) => {
  const { usuario, password, nombre, rol } = req.body;
  if (!usuario || !password || !rol) {
    return res.status(400).json({ success: false, error: 'Faltan datos obligatorios' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO usuarios (usuario, password, nombre, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [usuario, password, nombre || usuario, rol]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, error: 'El usuario ya existe' });
    }
    console.error('Error al crear usuario:', err.message);
    res.status(500).json({ success: false, error: 'Error al crear usuario' });
  }
});

app.get('/api/usuarios', async (_req, res) => {
  try {
    const result = await pool.query('SELECT id, usuario, nombre, rol FROM usuarios ORDER BY nombre ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al listar usuarios:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/estadisticas', async (req, res) => {
  const hoy = new Date().toISOString().split('T')[0];
  const desde = req.query.desde || hoy;
  const hasta = req.query.hasta || hoy;

  try {
    const totalResult = await pool.query(
      'SELECT COUNT(*)::int AS total FROM pdf_acta WHERE fecha_hora::date BETWEEN $1 AND $2',
      [desde, hasta]
    );

    const porInspectorResult = await pool.query(
      `SELECT u.id, u.nombre, u.usuario, COUNT(r.id)::int AS cantidad
       FROM pdf_acta r
       LEFT JOIN usuarios u ON u.id = r.id_inspector
       WHERE r.fecha_hora::date BETWEEN $1 AND $2
       GROUP BY u.id, u.nombre, u.usuario
       HAVING COUNT(r.id) > 0
       ORDER BY cantidad DESC`,
      [desde, hasta]
    );

    const faltantesResult = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tiene_cedula = false THEN 1 ELSE 0 END), 0)::int AS falta_cedula,
         COALESCE(SUM(CASE WHEN tiene_licencia = false THEN 1 ELSE 0 END), 0)::int AS falta_licencia,
         COALESCE(SUM(CASE WHEN tiene_seguro = false THEN 1 ELSE 0 END), 0)::int AS falta_seguro,
         COALESCE(SUM(CASE WHEN tiene_08_pago = false THEN 1 ELSE 0 END), 0)::int AS falta_08,
         COALESCE(SUM(CASE WHEN tiene_rto_habilitada = false THEN 1 ELSE 0 END), 0)::int AS falta_rto
       FROM pdf_acta
       WHERE fecha_hora::date BETWEEN $1 AND $2`,
      [desde, hasta]
    );

    res.json({
      totalHoy: totalResult.rows[0]?.total || 0,
      porInspector: porInspectorResult.rows,
      docsFaltantes: faltantesResult.rows[0] || {
        falta_cedula: 0,
        falta_licencia: 0,
        falta_seguro: 0,
        falta_08: 0,
        falta_rto: 0
      }
    });
  } catch (err) {
    console.error('Error al obtener estadísticas:', err.message);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

app.get('/api/exportar-registros', async (req, res) => {
  const hoy = new Date().toISOString().split('T')[0];
  const desde = req.query.desde || hoy;
  const hasta = req.query.hasta || hoy;

  try {
    const result = await pool.query(
      `SELECT r.id,
              COALESCE(r.patricula, r.patente) AS patricula,
              r.fecha_hora,
              u.nombre AS inspector,
              r.tiene_cedula,
              r.tiene_licencia,
              r.tiene_seguro,
              r.tiene_08_pago,
              r.tiene_rto_habilitada,
              r.observaciones
       FROM pdf_acta r
       LEFT JOIN usuarios u ON u.id = r.id_inspector
       WHERE r.fecha_hora::date BETWEEN $1 AND $2
       ORDER BY r.fecha_hora DESC`,
      [desde, hasta]
    );

    const headers = ['id','patricula','fecha_hora','inspector','tiene_cedula','tiene_licencia','tiene_seguro','tiene_08_pago','tiene_rto_habilitada','observaciones'];
    const lines = [headers.join(',')].concat(
      result.rows.map(row => headers.map(h => JSON.stringify(row[h] ?? '')).join(','))
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="registros-${desde}-a-${hasta}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Error al exportar registros:', err.message);
    res.status(500).json({ error: 'Error al exportar registros' });
  }
});

app.get('/acta/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT r.*, v.modelo, v.numero_08, v.fecha_seguro_vence, COALESCE(v.fecha_rto_vence, v.pdf_rto) AS fecha_rto_vence,
              u.nombre AS inspector_nombre, u.usuario AS inspector_usuario
       FROM pdf_acta r
       LEFT JOIN vehiculos v ON COALESCE(r.patricula, r.patente) = COALESCE(v.patricula, v.patente)
       LEFT JOIN usuarios u ON r.id_inspector = u.id
       WHERE r.id = $1
       LIMIT 1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('<h1>Acta no encontrada</h1>');
    }

    const acta = mapRegistro(result.rows[0]);
    const fechaControl = acta.fecha_hora ? new Date(acta.fecha_hora).toLocaleString('es-AR') : '-';
    const venceSeguro = acta.fecha_seguro_vence ? String(acta.fecha_seguro_vence).split('T')[0] : '-';
    const venceRTO = acta.fecha_rto_vence ? String(acta.fecha_rto_vence).split('T')[0] : '-';
    const siNo = (v) => (v ? 'Sí' : 'No');

    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Acta ${acta.id}</title>
<style>
body{font-family:Arial,sans-serif;background:#0f172a;color:#f8fafc;padding:20px;line-height:1.5}
.card{max-width:720px;margin:0 auto;background:#1e293b;padding:24px;border-radius:12px}
h1,h2{margin-top:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.muted{color:#94a3b8}
img{max-width:100%;border-radius:10px;background:#fff;margin-top:8px}
</style>
</head>
<body>
<div class="card">
<h1>Acta / Control #${acta.id}</h1>
<p><strong>Patente:</strong> ${acta.patricula || '-'}</p>
<p><strong>Fecha:</strong> ${fechaControl}</p>
<p><strong>Inspector:</strong> ${acta.inspector_nombre || '-'} (${acta.inspector_usuario || '-'})</p>
<p><strong>Modelo:</strong> ${acta.modelo || '-'}</p>
<p><strong>Nro. 08:</strong> ${acta.numero_08 || '-'}</p>
<p><strong>Vence seguro:</strong> ${venceSeguro}</p>
<p><strong>Vence RTO:</strong> ${venceRTO}</p>
<div class="grid">
<p><strong>Cédula:</strong> ${siNo(acta.tiene_cedula)}</p>
<p><strong>Licencia:</strong> ${siNo(acta.tiene_licencia)}</p>
<p><strong>Seguro:</strong> ${siNo(acta.tiene_seguro)}</p>
<p><strong>08 pago:</strong> ${siNo(acta.tiene_08_pago)}</p>
<p><strong>RTO habilitada:</strong> ${siNo(acta.tiene_rto_habilitada)}</p>
<p><strong>Ubicación:</strong> ${acta.texto_ubicacion || '-'}</p>
</div>
<p><strong>Observaciones:</strong> ${acta.observaciones || '-'}</p>
${acta.foto_evidencia ? `<h2>Foto</h2><img src="${acta.foto_evidencia}" alt="Foto evidencia">` : ''}
${acta.firma_conductor ? `<h2>Firma</h2><img src="${acta.firma_conductor}" alt="Firma conductor">` : ''}
</div>
</body>
</html>`);
  } catch (err) {
    console.error('Error al ver acta:', err.message);
    res.status(500).send('Error interno del servidor');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
