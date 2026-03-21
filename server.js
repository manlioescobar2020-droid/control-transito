// server.js - VERSIÓN LIMPIA Y ESTABLE
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
        // Buscamos en la tabla usuarios (esquema public por defecto)
        // LOWER() permite que "Man", "man" o "MAN" funcionen igual
        const result = await pool.query(
            'SELECT * FROM usuarios WHERE LOWER(usuario) = LOWER($1) AND password = $2', 
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
        // Buscamos datos del vehículo
        const vehiculoResult = await pool.query(
            'SELECT * FROM vehiculos WHERE patricula = $1', 
            [patricula.toUpperCase()]
        );
        
        // Buscamos el último control
        const controlResult = await pool.query(
            'SELECT fecha_hora, id_inspector FROM registros_controles WHERE patricula = $1 ORDER BY fecha_hora DESC LIMIT 1', 
            [patricula.toUpperCase()]
        );

        res.json({ 
            vehiculo: vehiculoResult.rows[0] || null, 
            ultimoControl: controlResult.rows[0] || null 
        });

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

        const {
            patricula, modelo, numero_08, fecha_seguro_vence, fecha_rto_vence,
            id_inspector, latitud, longitud, texto_ubicacion,
            tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones
        } = req.body;

        // A. Guardar/Actualizar Vehículo
        const upsertVehiculo = `
            INSERT INTO vehiculos (patricula, modelo, numero_08, fecha_seguro_vence, fecha_rto_vence)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (patricula)
            DO UPDATE SET
            modelo = EXCLUDED.modelo,
            numero_08 = EXCLUDED.numero_08,
            fecha_seguro_vence = EXCLUDED.fecha_seguro_vence,
            fecha_rto_vence = EXCLUDED.fecha_rto_vence
        `;
        await client.query(upsertVehiculo, [patricula.toUpperCase(), modelo, numero_08, fecha_seguro_vence, fecha_rto_vence]);

        // B. Guardar Registro del Control
        const insertRegistro = `
            INSERT INTO registros_controles
            (patricula, id_inspector, latitud, longitud, texto_ubicacion,
            tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
        `;
        const result = await client.query(insertRegistro, [
            patricula.toUpperCase(), id_inspector, latitud, longitud, texto_ubicacion,
            tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones
        ]);

        await client.query('COMMIT');

        // Emitir evento en tiempo real (para futuros paneles de control)
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

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor activo en puerto ${PORT}`);
});
