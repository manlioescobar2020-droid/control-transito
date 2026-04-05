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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function testDB() {
  try {
    const r = await pool.query('SELECT NOW()');
    console.log('✅ DB conectada:', r.rows[0].now);
  } catch (err) {
    console.error('❌ Error conectando DB:', err.message);
  }
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'down', error: err.message });
  }
});

app.post('/login', async (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({
      success: false,
      message: 'Faltan usuario o contraseña'
    });
  }

  try {
    const result = await pool.query(
      'SELECT id, usuario, nombre, rol FROM usuarios WHERE LOWER(usuario) = LOWER($1) AND password = $2',
      [usuario, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Usuario o contraseña incorrectos'
      });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Error en /login:', err);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

app.get('/api/vehiculos/:patricula', async (req, res) => {
  const patricula = String(req.params.patricula || '').toUpperCase().trim();

  if (!patricula) {
    return res.status(400).json({ error: 'Patrícula inválida' });
  }

  try {
    const vehiculoResult = await pool.query(
      'SELECT * FROM vehiculos WHERE patricula = $1',
      [patricula]
    );

    const controlResult = await pool.query(
      'SELECT * FROM pdf_acta WHERE patricula = $1 ORDER BY fecha_hora DESC LIMIT 1',
      [patricula]
    );

    res.json({
      vehiculo: vehiculoResult.rows[0] || null,
      ultimoControl: controlResult.rows[0] || null
    });
  } catch (err) {
    console.error('Error en /api/vehiculos/:patricula:', err);
    res.status(500).json({ error: 'Error al buscar vehículo' });
  }
});

app.post('/registrar-control', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const {
      patricula,
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

    const pat = String(patricula || '').toUpperCase().trim();

    if (!pat) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Falta la patente' });
    }

    const upsertVehiculo = `
      INSERT INTO vehiculos (
        patricula, modelo, numero_08, fecha_seguro_vence, fecha_rto_vence
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (patricula)
      DO UPDATE SET
        modelo = EXCLUDED.modelo,
        numero_08 = EXCLUDED.numero_08,
        fecha_seguro_vence = EXCLUDED.fecha_seguro_vence,
        fecha_rto_vence = EXCLUDED.fecha_rto_vence
    `;

    await client.query(upsertVehiculo, [
      pat,
      modelo || null,
      numero_08 || null,
      fecha_seguro_vence || null,
      fecha_rto_vence || null
    ]);

    const insertRegistro = `
      INSERT INTO pdf_acta (
        patricula,
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
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `;

    const result = await client.query(insertRegistro, [
      pat,
      id_inspector || null,
      latitud || null,
      longitud || null,
      texto_ubicacion || null,
      !!tiene_cedula,
      !!tiene_licencia,
      !!tiene_seguro,
      !!tiene_08_pago,
      !!tiene_rto_habilitada,
      observaciones || null,
      foto_evidencia || null,
      firma_conductor || null
    ]);

    await client.query('COMMIT');

    io.emit('nuevo_control_registrado', result.rows[0]);

    res.json({
      success: true,
      registro: result.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en /registrar-control:', err);
    res.status(500).json({
      success: false,
      error: 'Error al registrar control'
    });
  } finally {
    client.release();
  }
});

app.get('/api/historial', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;

    const result = await pool.query(
      `
      SELECT
        id,
        patricula,
        fecha_hora,
        latitud,
        longitud,
        observaciones,
        fecha_seguro_vence,
        fecha_rto_vence,
        tiene_cedula,
        tiene_licencia,
        tiene_seguro,
        tiene_08_pago,
        tiene_rto_habilitada
      FROM pdf_acta
      ORDER BY fecha_hora DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error en /api/historial:', err);
    res.status(500).json({
      error: 'Error al obtener historial',
      detalle: err.message
    });
  }
});

app.post('/api/crear-usuario', async (req, res) => {
  const { usuario, password, nombre, rol } = req.body;

  if (!usuario || !password || !rol) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO usuarios (usuario, password, nombre, rol)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [usuario, password, nombre || usuario, rol]
    );

    res.json({
      success: true,
      id: result.rows[0].id
    });
  } catch (err) {
    console.error('Error en /api/crear-usuario:', err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

app.get('/api/usuarios', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, usuario, nombre, rol FROM usuarios ORDER BY nombre ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error en /api/usuarios:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/estadisticas', async (req, res) => {
  try {
    const desde = req.query.desde;
    const hasta = req.query.hasta;

    if (!desde || !hasta) {
      return res.status(400).json({ error: 'Faltan fechas' });
    }

    const totalResult = await pool.query(
      'SELECT COUNT(*)::int AS total FROM pdf_acta WHERE fecha_hora::date BETWEEN $1 AND $2',
      [desde, hasta]
    );

    const porInspectorResult = await pool.query(
      `
      SELECT
        u.id,
        u.nombre,
        u.usuario,
        COUNT(r.id)::int AS cantidad
      FROM pdf_acta r
      LEFT JOIN usuarios u ON u.id = r.id_inspector
      WHERE r.fecha_hora::date BETWEEN $1 AND $2
      GROUP BY u.id, u.nombre, u.usuario
      HAVING COUNT(r.id) > 0
      ORDER BY cantidad DESC
      `,
      [desde, hasta]
    );

    const docsResult = await pool.query(
      `
      SELECT
        SUM(CASE WHEN COALESCE(tiene_cedula,false) = false THEN 1 ELSE 0 END)::int AS falta_cedula,
        SUM(CASE WHEN COALESCE(tiene_licencia,false) = false THEN 1 ELSE 0 END)::int AS falta_licencia,
        SUM(CASE WHEN COALESCE(tiene_seguro,false) = false THEN 1 ELSE 0 END)::int AS falta_seguro,
        SUM(CASE WHEN COALESCE(tiene_08_pago,false) = false THEN 1 ELSE 0 END)::int AS falta_08,
        SUM(CASE WHEN COALESCE(tiene_rto_habilitada,false) = false THEN 1 ELSE 0 END)::int AS falta_rto
      FROM pdf_acta
      WHERE fecha_hora::date BETWEEN $1 AND $2
      `,
      [desde, hasta]
    );

    res.json({
      totalHoy: totalResult.rows[0]?.total || 0,
      porInspector: porInspectorResult.rows || [],
      docsFaltantes: docsResult.rows[0] || {
        falta_cedula: 0,
        falta_licencia: 0,
        falta_seguro: 0,
        falta_08: 0,
        falta_rto: 0
      }
    });
  } catch (err) {
    console.error('Error en /api/estadisticas:', err);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

app.get('/api/exportar-registros', async (req, res) => {
  try {
    const desde = req.query.desde;
    const hasta = req.query.hasta;

    if (!desde || !hasta) {
      return res.status(400).send('Faltan fechas');
    }

    const result = await pool.query(
      `
      SELECT
        id,
        patricula,
        id_inspector,
        fecha_hora,
        latitud,
        longitud,
        texto_ubicacion,
        tiene_cedula,
        tiene_licencia,
        tiene_seguro,
        tiene_08_pago,
        tiene_rto_habilitada,
        observaciones
      FROM pdf_acta
      WHERE fecha_hora::date BETWEEN $1 AND $2
      ORDER BY fecha_hora DESC
      `,
      [desde, hasta]
    );

    const headers = [
      'id',
      'patricula',
      'id_inspector',
      'fecha_hora',
      'latitud',
      'longitud',
      'texto_ubicacion',
      'tiene_cedula',
      'tiene_licencia',
      'tiene_seguro',
      'tiene_08_pago',
      'tiene_rto_habilitada',
      'observaciones'
    ];

    const csvRows = [headers.join(',')];

    for (const row of result.rows) {
      const vals = headers.map(h => {
        const value = row[h] ?? '';
        return `"${String(value).replace(/"/g, '""')}"`;
      });
      csvRows.push(vals.join(','));
    }

    const csv = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=registros.csv');
    res.send(csv);
  } catch (err) {
    console.error('Error en /api/exportar-registros:', err);
    res.status(500).send('Error al exportar');
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
  await testDB();
});
