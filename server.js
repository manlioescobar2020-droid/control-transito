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
        const { patricula, modelo, numero_08, fecha_seguro_vence, fecha_rto_vence, id_inspector, latitud, longitud, texto_ubicacion, tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones } = req.body;

        // 1. Upsert del Vehículo (Esto ya estaba bien)
        const upsertVehiculo = `INSERT INTO vehiculos (patricula, modelo, numero_08, fecha_seguro_vence, fecha_rto_vence) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (patricula) DO UPDATE SET modelo = EXCLUDED.modelo, numero_08 = EXCLUDED.numero_08, fecha_seguro_vence = EXCLUDED.fecha_seguro_vence, fecha_rto_vence = EXCLUDED.fecha_rto_vence`;
        await client.query(upsertVehiculo, [patricula.toUpperCase(), modelo, numero_08, fecha_seguro_vence, fecha_rto_vence]);

        // 2. CORRECCIÓN: Insertar en el Historial incluyendo las fechas
        const insertRegistro = `INSERT INTO registros_controles (patricula, id_inspector, fecha_seguro_vence, fecha_rto_vence, latitud, longitud, texto_ubicacion, tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`;
        
        // AQUÍ AGREGAMOS LAS FECHAS AL ARRAY DE VALORES
        const result = await client.query(insertRegistro, [
            patricula.toUpperCase(), 
            id_inspector, 
            fecha_seguro_vence, // <--- NUEVO
            fecha_rto_vence,    // <--- NUEVO
            latitud, 
            longitud, 
            texto_ubicacion, 
            tiene_cedula, 
            tiene_licencia, 
            tiene_seguro, 
            tiene_08_pago, 
            tiene_rto_habilitada, 
            observaciones
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
        const limite = req.query.limit || 100;
        const queryText = `
            SELECT 
                r.id, r.patricula, r.fecha_hora, r.latitud, r.longitud, 
                v.modelo, v.numero_08,
                r.tiene_cedula, r.tiene_licencia, r.tiene_seguro, r.tiene_08_pago, r.tiene_rto_habilitada, r.observaciones
            FROM registros_controles r
            LEFT JOIN vehiculos v ON r.patricula = v.patricula
            ORDER BY r.fecha_hora DESC 
            LIMIT $1
        `;
        const result = await pool.query(queryText, [limite]);
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener historial:", err.message);
        res.status(500).json({ error: 'Error al obtener historial' });
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
        
        // Total de controles
        const totalResult = await pool.query("SELECT COUNT(*) as total FROM registros_controles WHERE fecha_hora::date BETWEEN $1 AND $2", [fechaDesde, fechaHasta]);
        
        // Controles por inspector
        const porInspectorResult = await pool.query(`SELECT u.id, u.nombre, u.usuario, COUNT(r.id) as cantidad FROM usuarios u INNER JOIN registros_controles r ON u.id = r.id_inspector WHERE r.fecha_hora::date BETWEEN $1 AND $2 GROUP BY u.id, u.nombre, u.usuario HAVING COUNT(r.id) > 0 ORDER BY cantidad DESC`, [fechaDesde, fechaHasta]);
        
        // NUEVO: Contador de documentos faltantes
        const faltantesResult = await pool.query(`
            SELECT 
                SUM(CASE WHEN tiene_cedula = false THEN 1 ELSE 0 END) as falta_cedula,
                SUM(CASE WHEN tiene_licencia = false THEN 1 ELSE 0 END) as falta_licencia,
                SUM(CASE WHEN tiene_seguro = false THEN 1 ELSE 0 END) as falta_seguro,
                SUM(CASE WHEN tiene_08_pago = false THEN 1 ELSE 0 END) as falta_08,
                SUM(CASE WHEN tiene_rto_habilitada = false THEN 1 ELSE 0 END) as falta_rto
            FROM registros_controles 
            WHERE fecha_hora::date BETWEEN $1 AND $2
        `, [fechaDesde, fechaHasta]);

        res.json({ 
            totalHoy: totalResult.rows[0].total, 
            porInspector: porInspectorResult.rows,
            docsFaltantes: faltantesResult.rows[0] // NUEVO DATO PARA EL FRONT
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener estadísticas' });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));
