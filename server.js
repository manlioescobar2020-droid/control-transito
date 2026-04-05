// server.js - VERSIÓN CON SINCRONIZACIÓN OFFLINE COMPLETA Y ESTADÍSTICAS DE FALTAS 
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();

// Configuración de Middlewares
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cors());

// Configuración de Socket.io
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});
console.log("DATABASE_URL existe:", !!process.env.DATABASE_URL);

if (process.env.DATABASE_URL) {
    const urlSinClave = process.env.DATABASE_URL.replace(/:\/\/(.*?):(.*?)@/, '://***:***@');
    console.log("DATABASE_URL visible:", urlSinClave);
}
// --- CONFIGURACIÓN DE BASE DE DATOS ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- RUTAS API ---

// 1. LOGIN
app.post('/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT id, usuario, nombre, rol FROM usuarios WHERE LOWER(usuario) = LOWER($1) AND password = $2', 
            [usuario, password]
        );

        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
        }
    } catch (err) {
        console.error("Error en Login:", err.message);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 2. BUSCAR VEHÍCULO
app.get('/vehiculos/:patricula', async (req, res) => {
    const { patricula } = req.params; 
    try {
        const vehiculoResult = await pool.query('SELECT * FROM vehiculos WHERE patricula = $1', [patricula.toUpperCase()]);
        const controlResult = await pool.query('SELECT * FROM registros_controles WHERE patricula = $1 ORDER BY fecha_hora DESC LIMIT 1', [patricula.toUpperCase()]);
        res.json({ vehiculo: vehiculoResult.rows[0] || null, ultimoControl: controlResult.rows[0] || null });
    } catch (err) {
        console.error("Error al buscar vehículo:", err.message);
        res.status(500).json({ error: 'Error al buscar vehículo' });
    }
});

// 3. REGISTRAR CONTROL
app.post('/registrar-control', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { patricula, modelo, numero_08, fecha_seguro_vence, fecha_rto_vence, id_inspector, latitud, longitud, texto_ubicacion, tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones, firma_conductor } = req.body;

        // --- CORRECCIÓN AQUÍ ---
        // Si la fecha está vacía (" "), la convertimos a NULL para que PostgreSQL la acepte
        const fechaSeguro = (fecha_seguro_vence && fecha_seguro_vence !== "") ? fecha_seguro_vence : null;
        const fechaRTO = (fecha_rto_vence && fecha_rto_vence !== "") ? fecha_rto_vence : null;
        // -----------------------

        // 1. Upsert del Vehículo (Usamos las variables limpias)
        const upsertVehiculo = `INSERT INTO vehiculos (patricula, modelo, numero_08, fecha_seguro_vence, fecha_rto_vence) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (patricula) DO UPDATE SET modelo = EXCLUDED.modelo, numero_08 = EXCLUDED.numero_08, fecha_seguro_vence = EXCLUDED.fecha_seguro_vence, fecha_rto_vence = EXCLUDED.fecha_rto_vence`;
        await client.query(upsertVehiculo, [patricula.toUpperCase(), modelo, numero_08, fechaSeguro, fechaRTO]);

        // 2. Insertar en el Historial (Usamos las variables limpias)
        const insertRegistro = `INSERT INTO registros_controles (patricula, id_inspector, fecha_seguro_vence, fecha_rto_vence, latitud, longitud, texto_ubicacion, tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones, foto_evidencia,firma_conductor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`;
        
        const result = await client.query(insertRegistro, [
            patricula.toUpperCase(), 
            id_inspector, 
            fechaSeguro, // <--- Usamos la variable limpia
            fechaRTO,    // <--- Usamos la variable limpia
            latitud, 
            longitud, 
            texto_ubicacion, 
            tiene_cedula, 
            tiene_licencia, 
            tiene_seguro, 
            tiene_08_pago, 
            tiene_rto_habilitada, 
            observaciones,
            req.body.foto_evidencia || null,
            firma_conductor || null
        ]);

        await client.query('COMMIT');
        io.emit('nuevo_control_registrado', result.rows[0]);
        res.json({ success: true, registro: result.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error al registrar control:", err.message);
        res.status(500).json({ error: 'Error al registrar control' });
    } finally {
        client.release();
    }
});
// 4. HISTORIAL PARA MAPA Y SINCRONIZACIÓN OFFLINE (CORREGIDO CON CHECKS)
app.get('/api/historial', async (req, res) => {
    try {
        const limite = parseInt(req.query.limit, 10) || 100;

        const queryText = `
            SELECT 
                id,
                patricula,
                fecha_hora,
                latitud,
                longitud,
                observaciones
            FROM registros_controles
            ORDER BY fecha_hora DESC
            LIMIT $1
        `;

        const result = await pool.query(queryText, [limite]);
        res.json(result.rows);

    } catch (err) {
        console.error("Error al obtener historial:", err);
        res.status(500).json({
            error: 'Error al obtener historial',
            detalle: err.message
        });
    }
});

// 5. CREAR USUARIO
app.post('/api/crear-usuario', async (req, res) => {
    const { usuario, password, nombre, rol } = req.body;
    if (!usuario || !password || !rol) return res.status(400).json({ error: "Faltan datos obligatorios" });
    try {
        const result = await pool.query('INSERT INTO usuarios (usuario, password, nombre, rol, dni) VALUES ($1, $2, $3, $4, $5) RETURNING id', [usuario, password, nombre || usuario, rol, null]);
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: "El usuario ya existe" });
        res.status(500).json({ error: 'Error al crear usuario' });
    }
});

// 6. LISTAR USUARIOS
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, usuario, nombre, rol FROM usuarios ORDER BY nombre ASC');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// 7. ESTADÍSTICAS (MODIFICADA PARA GRÁFICO DE TORTA)
app.get('/api/estadisticas', async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        const hoy = new Date().toISOString().split('T')[0];
        const fechaDesde = desde || hoy;
        const fechaHasta = hasta || hoy;

        const totalResult = await pool.query(
            `SELECT COUNT(*) AS total
             FROM registros_controles
             WHERE fecha_hora::date BETWEEN $1 AND $2`,
            [fechaDesde, fechaHasta]
        );

        const porInspectorResult = await pool.query(
            `SELECT 
                u.id,
                u.nombre,
                u.usuario,
                COUNT(r.id) AS cantidad
             FROM registros_controles r
             LEFT JOIN usuarios u ON u.id = r.id_inspector
             WHERE r.fecha_hora::date BETWEEN $1 AND $2
             GROUP BY u.id, u.nombre, u.usuario
             ORDER BY cantidad DESC`,
            [fechaDesde, fechaHasta]
        );

        const faltantesResult = await pool.query(
            `SELECT 
                COALESCE(SUM(CASE WHEN tiene_cedula = false THEN 1 ELSE 0 END), 0) AS falta_cedula,
                COALESCE(SUM(CASE WHEN tiene_licencia = false THEN 1 ELSE 0 END), 0) AS falta_licencia,
                COALESCE(SUM(CASE WHEN tiene_seguro = false THEN 1 ELSE 0 END), 0) AS falta_seguro,
                COALESCE(SUM(CASE WHEN tiene_08_pago = false THEN 1 ELSE 0 END), 0) AS falta_08,
                COALESCE(SUM(CASE WHEN tiene_rto_habilitada = false THEN 1 ELSE 0 END), 0) AS falta_rto
             FROM registros_controles
             WHERE fecha_hora::date BETWEEN $1 AND $2`,
            [fechaDesde, fechaHasta]
        );

        res.json({
            totalHoy: Number(totalResult.rows[0]?.total || 0),
            porInspector: porInspectorResult.rows,
            docsFaltantes: faltantesResult.rows[0] || {
                falta_cedula: 0,
                falta_licencia: 0,
                falta_seguro: 0,
                falta_08: 0,
                falta_rto: 0
            }
        });

    } catch (error) {
        console.error("Error al obtener estadísticas:", error);
        res.status(500).json({
            error: 'Error al obtener estadísticas',
            detalle: error.message
        });
    }
});

// 8. EXPORTAR CSV
app.get('/api/exportar-registros', async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        const hoy = new Date().toISOString().split('T')[0];
        const fechaDesde = desde || hoy;
        const fechaHasta = hasta || hoy;
        const query = `SELECT r.patricula, v.modelo, r.fecha_hora, u.nombre as inspector, r.tiene_cedula, r.tiene_licencia, r.observaciones FROM registros_controles r LEFT JOIN vehiculos v ON r.patricula = v.patricula JOIN usuarios u ON r.id_inspector = u.id WHERE r.fecha_hora::date BETWEEN $1 AND $2 ORDER BY r.fecha_hora DESC`;
        const result = await pool.query(query, [fechaDesde, fechaHasta]);
        let csv = 'Patente;Modelo;Fecha;Inspector;Cedula;Licencia;Obs\n';
        result.rows.forEach(row => {
            csv += `${row.patricula};${row.modelo || ''};${new Date(row.fecha_hora).toLocaleString()};${row.inspector};${row.tiene_cedula ? 'Si' : 'No'};${row.tiene_licencia ? 'Si' : 'No'};${row.observaciones || ''}\n`;
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=reporte.csv`);
        res.send(csv);
    } catch (error) {
        res.status(500).send("Error");
    }
});
// 9. VER ACTA / MULTA DESDE QR
app.get('/acta/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT
        r.id,
        r.patricula,
        r.fecha_hora,
        r.fecha_seguro_vence,
        r.fecha_rto_vence,
        r.texto_ubicacion,
        r.tiene_cedula,
        r.tiene_licencia,
        r.tiene_seguro,
        r.tiene_08_pago,
        r.tiene_rto_habilitada,
        r.observaciones,
        r.foto_evidencia,
        r.firma_conductor,
        v.modelo,
        v.numero_08,
        u.nombre AS inspector_nombre,
        u.usuario AS inspector_usuario
      FROM registros_controles r
      LEFT JOIN vehiculos v ON r.patricula = v.patricula
      LEFT JOIN usuarios u ON r.id_inspector = u.id
      WHERE r.id = $1
      LIMIT 1
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Acta no encontrada</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              background: #f8fafc;
              color: #0f172a;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              padding: 20px;
            }
            .card {
              background: white;
              padding: 24px;
              border-radius: 14px;
              box-shadow: 0 8px 24px rgba(0,0,0,0.08);
              max-width: 520px;
              width: 100%;
              text-align: center;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Acta no encontrada</h1>
            <p>No existe un acta con ID ${id}</p>
          </div>
        </body>
        </html>
      `);
    }

    const acta = result.rows[0];

    const fechaControl = acta.fecha_hora
      ? new Date(acta.fecha_hora).toLocaleString('es-AR')
      : '-';

    const fechaSeguro = acta.fecha_seguro_vence
      ? new Date(acta.fecha_seguro_vence).toISOString().split('T')[0]
      : '-';

    const fechaRTO = acta.fecha_rto_vence
      ? new Date(acta.fecha_rto_vence).toISOString().split('T')[0]
      : '-';

    const siNo = (valor) => valor ? 'Sí' : 'No';
    const claseEstado = (valor) => valor ? 'ok' : 'bad';
res.send(`
  <!DOCTYPE html>
  <html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Acta #${acta.id}</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        background: #f8fafc;
        color: #0f172a;
        margin: 0;
        padding: 20px;
      }
      .contenedor {
        max-width: 820px;
        margin: 0 auto;
      }
      .card {
        background: #ffffff;
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.08);
      }
      h1 {
        margin-top: 0;
        margin-bottom: 10px;
      }
      h2 {
        margin-top: 28px;
        margin-bottom: 12px;
        font-size: 20px;
      }
      p {
        margin: 8px 0;
        line-height: 1.45;
      }
      .acciones {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 20px;
      }
      .btn {
        border: none;
        border-radius: 10px;
        padding: 12px 16px;
        font-size: 14px;
        font-weight: bold;
        cursor: pointer;
      }
      .btn-primary {
        background: #2563eb;
        color: white;
      }
      .btn-secondary {
        background: #0f766e;
        color: white;
      }
      .btn-light {
        background: #e2e8f0;
        color: #0f172a;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .item {
        background: #f1f5f9;
        border-radius: 12px;
        padding: 12px;
      }
      .ok {
        color: #15803d;
        font-weight: bold;
      }
      .bad {
        color: #b91c1c;
        font-weight: bold;
      }
      .bloque-img {
        margin-top: 20px;
      }
      img {
        max-width: 100%;
        border-radius: 12px;
        border: 1px solid #cbd5e1;
        margin-top: 8px;
        background: white;
      }
      .obs {
        background: #fff7ed;
        border-left: 4px solid #f97316;
        padding: 12px;
        border-radius: 10px;
      }
      .nota {
        margin-top: 14px;
        font-size: 13px;
        color: #475569;
      }

      @media (max-width: 640px) {
        .grid {
          grid-template-columns: 1fr;
        }
        body {
          padding: 12px;
        }
        .card {
          padding: 18px;
        }
        .acciones {
          flex-direction: column;
        }
        .btn {
          width: 100%;
        }
      }

      @media print {
        body {
          background: white;
          padding: 0;
        }
        .acciones,
        .nota {
          display: none !important;
        }
        .card {
          box-shadow: none;
          border-radius: 0;
          padding: 0;
        }
      }
    </style>
  </head>
  <body>
    <div class="contenedor">
      <div class="card">
        <div class="acciones">
          <button class="btn btn-primary" onclick="descargarPDF()">📄 Descargar / Guardar PDF</button>
          <button class="btn btn-secondary" onclick="compartirActa()">📤 Compartir</button>
          <button class="btn btn-light" onclick="window.location.reload()">🔄 Recargar</button>
        </div>

        <h1>Acta de Infracción #${acta.id}</h1>

        <p><strong>Patente:</strong> ${acta.patricula || '-'}</p>
        <p><strong>Modelo:</strong> ${acta.modelo || '-'}</p>
        <p><strong>Número 08:</strong> ${acta.numero_08 || '-'}</p>
        <p><strong>Fecha del control:</strong> ${fechaControl}</p>
        <p><strong>Inspector:</strong> ${acta.inspector_nombre || acta.inspector_usuario || '-'}</p>
        <p><strong>Ubicación:</strong> ${acta.texto_ubicacion || '-'}</p>

        <h2>Documentación</h2>
        <div class="grid">
          <div class="item">Cédula: <span class="${claseEstado(acta.tiene_cedula)}">${siNo(acta.tiene_cedula)}</span></div>
          <div class="item">Licencia: <span class="${claseEstado(acta.tiene_licencia)}">${siNo(acta.tiene_licencia)}</span></div>
          <div class="item">Seguro: <span class="${claseEstado(acta.tiene_seguro)}">${siNo(acta.tiene_seguro)}</span></div>
          <div class="item">08 pago: <span class="${claseEstado(acta.tiene_08_pago)}">${siNo(acta.tiene_08_pago)}</span></div>
          <div class="item">RTO habilitada: <span class="${claseEstado(acta.tiene_rto_habilitada)}">${siNo(acta.tiene_rto_habilitada)}</span></div>
        </div>

        <h2>Vencimientos</h2>
        <p><strong>Seguro vence:</strong> ${fechaSeguro}</p>
        <p><strong>RTO vence:</strong> ${fechaRTO}</p>

        <h2>Observaciones</h2>
        <div class="obs">
          ${acta.observaciones ? acta.observaciones : 'Sin observaciones'}
        </div>

        ${acta.foto_evidencia ? `
          <div class="bloque-img">
            <h2>Foto evidencia</h2>
            <img src="${acta.foto_evidencia}" alt="Foto evidencia del control">
          </div>
        ` : ''}

        ${acta.firma_conductor ? `
          <div class="bloque-img">
            <h2>Firma del conductor</h2>
            <img src="${acta.firma_conductor}" alt="Firma del conductor">
          </div>
        ` : ''}

        <div class="nota">
          Consejo: en Android, al tocar “Descargar / Guardar PDF”, se abre la vista de impresión y desde ahí podés elegir “Guardar como PDF”.
        </div>
      </div>
    </div>

    <script>
      function descargarPDF() {
        window.print();
      }

      async function compartirActa() {
        const url = window.location.href;
        const titulo = document.title;
        const texto = 'Acta de infracción ' + titulo;

        if (navigator.share) {
          try {
            await navigator.share({
              title: titulo,
              text: texto,
              url: url
            });
          } catch (e) {
            console.log('Compartir cancelado', e);
          }
        } else {
          try {
            await navigator.clipboard.writeText(url);
            alert('Enlace copiado al portapapeles');
          } catch (e) {
            prompt('Copiá este enlace:', url);
          }
        }
      }
    </script>
  </body>
  </html>
`);
      } catch (error) {
    console.error('Error al abrir acta:', error.message);
    res.status(500).send('Error interno al generar el acta');
  }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));
