// server.js - MODO DEBUG
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
// --- AGREGAR ESTAS 3 LÍNEAS ---
console.log("--- DIAGNÓSTICO DE RENDER ---");
console.log("¿DATABASE_URL existe?", process.env.DATABASE_URL ? "SÍ" : "NO");
console.log("-----------------------------");
// --------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- RUTA DE LOGIN CON DEBUG ---
app.post('/login', async (req, res) => {
    const { usuario, password } = req.body;
    console.log(`--- INTENTO DE LOGIN ---`);
    console.log(`Usuario recibido: "${usuario}"`);
    console.log(`Password recibido: "${password}"`);

    try {
        // 1. Intentamos buscar en 'production'
        let result = await pool.query('SELECT * FROM production.usuarios WHERE usuario = $1 AND password = $2', [usuario, password]);
        console.log(`Buscando en 'production.usuarios': ${result.rows.length} resultados`);
        
        // 2. Si no hay, intentamos en 'public' (sin prefijo)
        if (result.rows.length === 0) {
            result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1 AND password = $2', [usuario, password]);
            console.log(`Buscando en 'public.usuarios': ${result.rows.length} resultados`);
        }
        
        // 3. Si todavía no hay, listamos todos los usuarios para ver qué hay
        if (result.rows.length === 0) {
            const todos = await pool.query("SELECT * FROM production.usuarios");
            console.log("USUARIOS EXISTENTES EN PRODUCTION:", todos.rows);
            const todosPublic = await pool.query("SELECT * FROM usuarios");
            console.log("USUARIOS EXISTENTES EN PUBLIC:", todosPublic.rows);
        }

        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'Credenciales incorrectas (Ver logs para detalles)' });
        }
    } catch (err) {
        console.error("ERROR CRÍTICO:", err.message);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// --- RUTAS VEHÍCULOS (Simplificadas para probar) ---
app.get('/vehiculos/:patricula', async (req, res) => {
    const { patricula } = req.params;
    try {
        // Intentamos en ambos lados
        let vehiculo = await pool.query('SELECT * FROM production.vehiculos WHERE patricula = $1', [patricula.toUpperCase()]);
        if (vehiculo.rows.length === 0) vehiculo = await pool.query('SELECT * FROM vehiculos WHERE patricula = $1', [patricula.toUpperCase()]);
        
        let control = await pool.query('SELECT * FROM production.registros_controles WHERE patricula = $1 ORDER BY fecha_hora DESC LIMIT 1', [patricula.toUpperCase()]);
        if (control.rows.length === 0) control = await pool.query('SELECT * FROM registros_controles WHERE patricula = $1 ORDER BY fecha_hora DESC LIMIT 1', [patricula.toUpperCase()]);

        res.json({ vehiculo: vehiculo.rows[0], ultimoControl: control.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error' });
    }
});

// --- REGISTRAR CONTROL (Simplificado) ---
app.post('/registrar-control', async (req, res) => {
    // (Usa el mismo código de antes si quieres, o ponemos uno simple luego)
    res.json({ success: true, message: "Recibido" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
