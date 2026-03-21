// server.js
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // Necesario para servir la web app

const app = express();

// Configuración para servir archivos estáticos (la carpeta 'public')
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cors());

// Configuración de Socket.io
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- CONFIGURACIÓN DE BASE DE DATOS (PARA INTERNET) ---
// Ya no ponemos la contraseña aquí, la leeremos de las variables del servidor
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, 
  ssl: {
    rejectUnauthorized: false
  }
});

// ... (todo el medio del código igual) ...

// INICIAR SERVIDOR
// Render asigna un puerto dinámico, lo leemos con process.env.PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor listo en el puerto ${PORT}`);
});
// --- RUTAS API ---

// 1. LOGIN
app.post('/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1 AND password = $2', [usuario, password]);
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
        }
    } catch (err) {
        console.error("Error Login:", err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// 2. BUSCAR VEHÍCULO (MEJORADO)
app.get('/vehiculos/:patricula', async (req, res) => {
    const { patricula } = req.params;
    const client = await pool.connect(); // Usamos cliente para transacciones seguras
    
    try {
        // A. Buscar datos del vehículo
        const vehiculoResult = await client.query('SELECT * FROM vehiculos WHERE patricula = $1', [patricula.toUpperCase()]);
        
        // B. Buscar el ÚLTIMO control de ese vehículo
        const controlResult = await client.query(
            'SELECT fecha_hora, id_inspector FROM registros_controles WHERE patricula = $1 ORDER BY fecha_hora DESC LIMIT 1', 
            [patricula.toUpperCase()]
        );

        const vehiculo = vehiculoResult.rows[0] || null;
        const ultimoControl = controlResult.rows[0] || null;

        res.json({ 
            vehiculo, 
            ultimoControl 
        });

    } catch (err) {
        console.error("Error Buscar:", err);
        res.status(500).json({ error: 'Error al buscar vehículo' });
    } finally {
        client.release();
    }
});
// 3. REGISTRAR CONTROL
app.post('/registrar-control', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        console.log("?? Recibiendo datos de control...");

        const { 
            patricula, modelo, numero_08, fecha_seguro_vence, fecha_rto_vence, 
            id_inspector, latitud, longitud, texto_ubicacion, 
            tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones 
        } = req.body;

        // A. Guardar o Actualizar Vehículo (Upsert)
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
        console.log("? Control guardado exitosamente en DB");
        
        // Emitir evento en tiempo real
        io.emit('nuevo_control_registrado', result.rows[0]);
        
        res.json({ success: true, registro: result.rows[0] });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("? ERROR AL GUARDAR:", err);
        res.status(500).json({ error: 'Error al registrar control', details: err.message });
    } finally {
        client.release();
    }
});
