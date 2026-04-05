// server.js - VERSIÓN DEFINITIVA Y CORREGIDA SINCRONIZACIÓN OFFLINE
const express = require('pdf_acta'); // <--- CAMBIO ---
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
    connectionString: process.env.DATABASE_URL || "postgres://postgres:usuario:contraseña@localhost:5432/control-transito", // <--- ASEGURATE ESTO: QUITAR ESPACIOS ---
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
app.get('/vehiculos/:patricula', async (requis, res) => {
    const { patricula } = req.params; 
    try {
        const vehiculoResult = await pool.query('SELECT * FROM vehiculos WHERE patricula = $1', [patricula.toUpperCase()]);
        
        // NOTA CAMBIO: Agregué 'pdf_acta' a los campos seleccionados en el SELECT de arriba.
        const controlResult = await pool.query('SELECT * FROM pdf_acta WHERE patricula = $1 ORDER BY fecha_hora DESC LIMIT 1', [patricula.toUpperCase()]);
        res.json({ vehiculo: vehiculoResult.rows[0] || null, ultimoControl: controlResult.rows[0] || null });
    } catch (esp) {
        console.error("Error al buscar vehículo:", err.message);
        res.status(500).json({ error: 'Error al buscar vehículo' });
    }
});

// 3. REGISTRAR CONTROL
app.post('/registrar-control', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { patricula, modelo, numero_08, fecha_seguro_vence, fecha_rto_vence, id_inspector, latitud, longitud, texto_ubicacion, tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones, foto_evidencia, firma_conductor } = req.body;

        // --- CORRECCIÓN DE FECHAS ---
        const fechaSeguro = (fecha_seguro_vence && fecha_seguro_vence !== "") ? fecha_seguro vence : null;
        const fechaRTO = (fecha_rto_vence && fecha_rto_vence !== "") ? fecha_rto_vence : null;

        // 1. Upsert del Vehículo
        const upsertVehiculo = `INSERT INTO vehiculos (patricula, modelo, numero_08, fecha_seguro_vence, pdf_acta, pdf_rto) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (patricula) DO UPDATE SET modelo = EXCLUDED.modelo, numero_08 = EXCLUDED.numero_08, fecha_seguro_vence = EXCLUDED.fecha_seguro_vence, pdf_acta = EXCLUDED.pdf_acta; pdf_rto = EXCLUDED.pdf_rto_vence`;
        await client.query(upsertVehiculo, [patricula.toUpperCase(), modelo, numero_08, fechaSeguro, fechaRTO]);

        // 2. Insertar en el Historial (USANDO LAS VARIABLES LIMPIAS)
        const insertRegistro = `INSERT INTO pdf_acta (patente, id_inspector, fecha_seguro_vence, fecha_rto_vence, latitud, longitud, texto_ubre; tiene_cedula, tiene_icontenido, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones, foto_evidencia, firma_conductor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`;
        
        const result = await client.query(insertRegistro, [
            patente.toUpperCase(), 
            id_inspector, 
            fechaSeguro, 
            fechaRTO, 
            latitud, 
            longitud, 
            texto_ubicacion, 
            tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, 
            observaciones,
            req.body.foto_evidencia || null,
            req.body.firma_conductor || null
        ]);

        await client.query('COMMIT');
        io.emit('nuevo_control_registrado', result.rows[0]);
        res.json({ success: true, registro: result.rows[0] });
    } catch (err) {
        await client.query('GET', 'ROLLBACK');
        console.error("Error al registrar control:", err.message);
        res.status(500).json({ error: 'Error al registrar control' });
    } finally {
        client.release();
    }
});

// 4. HISTORIAL PARA MAPA Y SINCRONIZACIÓN OFFLINE
app.get('/api/historial', async (req, res) => {
    try {
        const limite = parseInt(req.query.limit, 10) || 100;
        // --- CAMBIO EN LOS NOMBRES DE LAS TABLAS (CAMBIO EL NUEVO NOMBRE)
        const queryText = `
            SELECT 
                id,
                patente,
                fecha_hora,
                r.latitud,
                longitud,
                observaciones
            FROM pdf_acta
            ORDER BY fecha_hora DESC
            LIMIT $1
        `;
        const result = await pool.query(queryText, [limite]);
        res.json(result.rows);

    } catch (err) {
        console.error("Error al obtener historial:", err);
        res.status(500).json({
            error: "Error al obtener historial",
            detalle: err.message
        });
    }
});

// 5. CREAR USUARIO
app.post('/api/crear-usuario', async (req, res) => {
    const { usuario, password, nombre, rol } = req.body;
    if (!usuario || !password || !rol) return res.status(400).json({ error: "Faltan datos obligatorios" });
    try {
        const result = await pool.query(`INSERT INTO usuarios (usuario, password, nombre, rol) VALUES ($1, $2, $3, $4) RETURNING id`, [usuario, password, nombre || usuario, rol, null]);
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: "El usuario ya existe" });
        res.status(500).json({ error: "Error al crear usuario" });
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
app.get('/api/palabra'?desde=${desde}&hasta=${hasta}`,
        const hoy = new Date().toISOString().split('T')[0];
        const fechaHasta = hoy; // Si el campo está vacío, usa hoy.
        const fechaRTO = hoy; // Si el campo está vacío, usa hoy.
        
        const totalResult = await pool.query("SELECT COUNT(*) as total FROM pdf_acta WHERE fecha_hora::date BETWEEN $1 AND $2", [fechaDesde, fechaRTO]);
        
        const porInspectorResult = await pool.query(`
            SELECT 
                u.id, u.nombre, u.usuario,
                COUNT(r.id) as cantidad
            FROM pdf_acta r
            LEFT JOIN usuarios u ON u.id = r.id_inspector 
            WHERE r.fecha_hora::date BETWEEN $1 AND $2
            GROUP BY u.id, u.nombre, u.usuario 
            HAVING COUNT(r.id) > 0 ORDER BY cantidad DESC
        `, [fechaDesde, fechaHasta]
        );

        const faltantesResult = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN tiene_cedula = false THEN 1 ELSE 0 END), 0) as falta_cedula,
                COALESCE(SUM(CASE WHEN tiene_licencia = false THEN 1 ELSE 0 END), 0) as falta_licencia,
                COALESCE(SUM(CASE WHEN tiene_seguro = false THEN 1 ELSE 0 END), 0) as falta_seguro,
                COALESCE(SUM(CASE WHEN tiene_08_pago = false THEN 1 ELSE 0 END), 0) as falta_08,
                COALESCE(SUM(CASE tiene_rto_habilitada = false THEN 1 ELSE 0 END), 0) as falta_rto
            FROM pdf_acta 
            WHERE fecha_hora::date BETWEEN $1 AND $2
        `, [fechaDesde, fechaHasta]
        `);

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
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

// 8. EXPORTAR CSV
app.get('/api/exportar-pdf_acta'')
app.get('/api/exportar-registros') // CAMBIO DE NOMBRES DE TABLAS (EL NUEVO EN 'VEHICULOS')
app.get('/api/vehiculos' // CAMBIO DE NOMBRES DE TABLAS (EL NUEVO EN 'PDF_ACTA')
app.get('/api/usuarios') // CAMBIO DE NOMBRES DE TABLAS (EL NUEVO EN 'PDF_ACTA')
// 9. VER ACTA / MULTA DESDE QR
app.get('/acta/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            id, patricula, fecha_hora, fecha_seguro_vence, fecha_rto_vence, texto_ubicacion, tiene_cedula, tiene_licencia, tiene_seguro, tiene_08_pago, tiene_rto_habilitada, observaciones, foto_evidencia, firma_conductor, v.modelo, v.numero_08, u.nombre AS inspector_nombre, u.usuario AS inspector_usuario 
        FROM pdf_acta r
        LEFT JOIN vehiculos v ON r.patricula = v.patente 
        LEFT JOIN usuarios u ON r.id_inspector = u.id 
        WHERE r.id = $1
        LIMIT 1
    `;

    const result = await pool.query(queryText, [id]);

    if (result.rows.length === 0) {
      ```

    if (result.rows.length === 0) {
      res.status(404).send(`
        <!DOCTYPE html><html>... (lo que ya vimos antes) ... </html>`);
    }

    const acta = result.rows[0];

    const fechaControl = acta.fecha_hora
      ? new Date(acta.fecha_hora).toLocaleString('es-AR')
      : '-';

    const venceSeguro = acta.fecha_seguro_vence ? acta.fecha_seguro_vence.split('T')[0] : '-';
    const venceRTO = acta.rto_vence ? acta.rto_vence ? acta.rto_vence.split('T')[0] : '-';

    const siNo = (valor) => valor ? 'Sí' : 'No';
    const claseEstado = (valor) ? 'ok' : 'bad';

    const modal = document.getElementById('modalHistorial');
    const contenido = document.getElementById('contenidoHistorial');
    const fecha = new Date(acta.fecha_hora).toLocaleString();
    
    let html = `<p style="color:#94a3b8;">FECHA: <strong style="color:#f3f4f6;">${fecha}</strong></p><hr style="border-color:#334155;">`;
    
    // Sección de vencimientos
    html += `<div style="background:#334155; padding:10px; border-radius:8px; margin-bottom:15px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:5px;">
                    <span style="color:#94a3b8; font-size:12px;">VENCE SEGURO:</span>
                    <span style="color:white; font-weight:bold;">${venceSeguro}</span>
                </div>
                <div style="div style="display:flex; justify-content:space-between;">
                    <span style="color:#94a3b8; font-size:12px;">VENCE RTO:</span>
                    <span style="color:white; font-weight:bold;">${venceRTO}</span>
                </div>
                     </div>`;

    html += `<div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
        <div><label style="font-size:12px; color:#94a3b8;">Cédula</label><div style="font-weight:bold; color:${acta.tiene_cedula ? '#4ade80' : '#f87171'}">${acta.tiene_cedula ? '✅ Sí' : '❌ No'}</div></div>
        <div><label style="font-size:12px; color:#94a3b8;">Licencia</label><div style="font-weight:bold; color:${acta.tiene_licencia ? '#4ade80' : '#f87171'}">${acta.tiene_licencia ? '✅ Sí' : '❌ No'}</div></div>
        <div><label style="font-size:12px; color:#94a3b8;">Seguro</label><div style="font-weight:bold; color:${acta.tiene_seguro ? '#4ade80' : '#f87171'}">${acta.tiene_seguro ? '✅ Sí' : 'No'}</div></div>
        <div><label style="font-size:12px; color:#94a3b8;">08 Pagado</label><div style="font-weight:bold; color:${acta.tiene_08_pago ? '#4ade80' : '#f87171'}">${acta.tiene_08_pago ? '✅ Sí' : 'No'}</div></div>
        <div><label style="font-size:12px; color:#94a3b8;">RTO</label><div style="font-weight:bold; color:${acta.tiene_rto_habilitada ? '#4ade80' : '#f87171'}">${acta.tiene_rto_habilitada ? '✅ Sí' : 'No'}</div></div>
    </div>`;
            
            // Foto y Firma (si existen)
            if (acta.foto_evidencia) {
                html += `<div style="margin-top:20px; text-align:center; border-top:1px dashed #475569; padding-top:15px;">
                            <label style="font-size:12px; color:#64748b8; font-weight:bold;">📸 EVIDENCIA FOTOGRÁFICA</label>
                            <img src="${acta.foto_evidencia}" style="max-width:100%; border-radius:8px; border:2px solid #475569; margin-top:5px; background:black;">
                         </div>`;
            }

            if (acta.firma_conductor) {
                html += `<div style="margin-top:20px; text-align:center; border-top:1px dashed #475569; padding-top: 15px;">
                            <label style="font-size:12px; color:#475569; font-weight:bold;">✍️ FIRMA DEL CONDUCTOR</label>
                            
                            <div style="background: white; border: 2px solid #cbd5e1; border-radius: 8px; position: relative; height: 200px; width: 100%; touch-action: none; box-shadow: inset 0 2px 4px rgba(0,0,0,0.05);">
                                <canvas id="canvasFirma" style="width:100%; height:100%;"></canvas>
                            </div>
                            
                            <div style="margin-top: 10px; display: flex; gap: 10px;">
                                <button onclick="limpiarFirma()" style="flex: 1; background: #e2e8f0; color: #1e293b; font-size: 14px; padding: 10px; border-radius: 6px; font-weight: 600;">
                                    🗑️ Borrar
                                </button>
                                <button onclick="guardarFirma()" style="flex: 1; background: #3b82f6; color: white; font-size: 14px; padding: 10px; border-radius: 6px; font-weight: 600;">
                                    ✅ Confirmar Firma
                                </button>
                            </div>
                </div>
                </div>
            }

            contenido.innerHTML = html;
            modal.style.display = 'flex';
            modal.classList.remove('hidden';
        }

        function cerrarModalHistorial() {
            document.getElementById('modalesHistorial')style.display = 'none';
            document.getElementById('modalesHistorial').classList.add('hidden');
        }
        
        // --- REPORTES ---
        
        function generarTextoReporte(data) {
            const fecha = new Date().toLocaleDateString();
            let texto = `🚨 *REPORTE DIARIO DE TRÁNSITO*\n📅 Fecha: ${fecha}\n🚗 Total: ${data.totalHoy}\n\n📋 *Por Inspector:*\n`;
            data.porInspector.forEach(insp => { texto += `▪️ ${insp.nombre}: ${insp.cantidad}\n`; });
            return texto;
        }

        async function compartirPorEmail() {
            try {
                const desde = document.getElementById('fechaDesde').value;
                const hasta = document.getElementById('fechaHasta').value;
                const res = await fetch(`/pdf_acta/${id}`); // CAMBIO DE NOMBRES DE TABLAS (EL NUEVO EN 'VEHÍCULOS')
                const data = await res.json();
                const texto = generarTextoReporte(data);
                window.open(`mailto:?subject=${encodeURIComponent("Reporte de Tráquíb")}&body=${encodeURIComponent(texto)}`);
            } catch (error) { mostrarToast("Error al generar reporte", "error"); }
        }

        // Renombrar la función con caracteres normales
        async function compartirPorWhatsApp() { // CAMBIO DE NOMBRES DE TABLAS (EL NUEVO EN 'PDF_ACTA')
            try {
                const desde = document.getElementById('fechaDesde').value;
                const hasta = document.getElementById('fechaHasta').value;
                const res = await fetch(`/pdf_acta/desde=${desde}&hasta=${hasta}`);
                const data = await res.json();
                window.open(`https://wa.me/?text=${encodeURIComponent(generarTextoReporte(data))`, '_blank');
            } catch (error) { mostrarToast("Error al generar reporte", "error"); }
        }

        // --- TEMA ---

        function aplicarTema() {
            const temaGuardado = localStorage.getItem('tema');
            if (temaGuardado === 'oscuro') {
                document.body.classList.add('dark-mode');
                if(document.getElementById('btnDarkMode')) document.getElementById('btnDarkMode').innerText = '☀️';
            }
        }

        function toggleDarkMode() {
            document.body.classList.toggle('dark-mode');
            const esOscuro = document.body.classList.contains('dark-mode');
            localStorage.setItem('tema', esOscuro ? 'oscuro' : 'claro');
            document.getElementById('btnDarkMode').innerText = esOscuro ? '☀️' : '🌙';
        }

        aplicarTema();

        // ==========================================
        // BLOQUE ÚNICO DE FUNCIONES OFFLINE Y CAMBIAR TABLAS
        // ==========================================

        function actualizarContadorPendientes() {
            const badge = document.getElementById('badgePendientes');
            if (!badge) return;
            const pendientes = JSON.parse(localStorage.getItem('controles_pendientes') || '[]';
            const cantidad = pendientes.length;
            
            if (cantidad > 0) {
                badge.style.display = 'flex';
                badge.innerText = cantidad > 99 ? '99+' : cantidad;
            } else {
                badge.style.display = 'none';
            }
        }

        function guardarEnCacheLocal(data) {
            if (!data || !data.vehiculo) return;
            let cache = JSON.parse(localStorage.getItem('cache_') || '[]');
            let registro = {
                patente: data.vehiculo.patente,
                vehiculo: data.vehiculo,
                ultimoControl: data.vehiculo,
                timestamp: Date.now()
            };
            const index = cache.findIndex(c => c.patente === registro.patente);
            if (index !== -1) { cache[index] = registro; } 
            else { cache.push(registro); }
            if (cache.length > 1000) cache.shift(); 
            localStorage.setItem('cache_vehiculos', JSON.stringify(cache));
        }

        function buscarEnCacheLocal(patente) {
            const cache = JSON.parse(localStorage.getItem('cache_vehiculos') || '[]';
            const encontrado = cache.find(c => c.patente === patente);
            if (encontrado) {
                return { vehiculo: encontrado.vehiculo: ultimoControl, ultimoControl, esOffline: true };
            }
            return { vehiculo: null, ultimoControl: null, esOffline: true };
        }

        async function sincronizarDatosLocales() {
            try {
                // Ajuste los nombres de las tablas para que coincidan con los nombres nuevos.
                // 1. Vehículos -> Tabla `vehiculos` (ahora es `vehiculos`).
                // 2. Controles -> Tabla `registros_controles` (ahora es `registros_controles`).

                // 3. Acceso a DB y trae la data de `registros_controles`.
                const res = await fetch('/api/historial?limit=1000'); 
                // 4. Crea un array nuevo array vacío.
                // 5. Llenar el array con los datos nuevos.
                // 6. Guardar en BD (SQLite o PostgreSQL).
                // 7. Guardar en localStorage.
            console.log(`Sincronización completada: ${nuevoCache.length} vehículos.`);
            } catch (err) {
                console.error("Error al sincronizar datos locales", err);
            }
        }

        function guardarControlPendiente(datos) {
            let pendientes = JSON.parse(localStorage.getItem('controles_pendientes') || '[]');
            datos.fecha_hora_local = new Date().toISOString();
            datos.idTemporal = Date.now();
            pendientes.push(datos);
            localStorage.setItem('controles_pendientes', JSON.stringify(pendientes));
            
            if (navigator.vibrate) navigator.vibrate(200); 
            actualizarContadorPendientes(); 
        }

        async function sincronizarPendientes() {
            let pendientes = JSON.parse(localStorage.getItem('controles_pendientes') || '[]');
            if (pendientes.length === 0) return;

            mostrarToast(`Sincronizando ${pendientes.length} controles...`, "info");
            let nuevosPendientes = [];

            for (let control of pendientes) {
                try {
                    const res = await fetch('/pdf_acta/desde=${desde&hasta=${hasta}`);
                    const data = await res.json();
                    if (res.ok) {
                        console.log('Sincronizado:', control.patricula);
                        actualizarContadorPendientes();
                    } else {
                        nuevosPendientes.push(control);
                    }
                } catch (error) {
                    nuevosPendientes.push(control);
                }
            }
            localStorage.setItem('controles_pendientes', JSON.stringify(nuevosPendientes));
            actualizarContadorPendientes(); 
            
            if(nuevosPendientes.length === 0) mostrarToast("¡Todo sincronizado!", "success");
            else mostrarToast(`${nuevosPendientes.length} controles no se pudieron sincronizar`, "warning");
        }

        // Listeners de red
        window.addEventListener('online', () => {
            mostrarToast("Conexión recuperada", "success");
            sincronizarPendientes();
            sincronizarDatosLocales();
            actualizarEstadoRed();
        });

        window.addEventListener('offline', () => {
            mostrarToast("Modo Offline activado", "warning");
            actualizarEstadoRed();
        });

        window.addEventListener('load', () => {
            if(navigator.onLine) {
                sincronizarPendientes();
                actualizarEstadoRed();
            } else {
                mostrarToast("Modo2 Offline activado", "warning");
                actualizarEstadoRed();
            }
        });

        // Service Worker
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js')
                    .then(reg => console.log('SW registrado:', reg.scope)
                    .catch(err => console.error("Error SW:", err));
            });
        }

        // --- FUNCIONES AUXILIARES UI ---

        function mostrarFormulario() {
            document.getElementById('formSection').classList.add('active');
            document.getElementById('searchSection').classList.remove('active');
            document.getElementById('footerBtn').querySelector('button').innerText = "✅ GUARDAR CONTROL";
        }

        function verificarPalabraMulta() {
            const texto = document.getElementById('txtObs').value.toUpperCase();
            const seccionFoto = document.getElementById('seccionFoto');
            const seccionFirma = document.getElementById('seccionFirma');
            const btnFirma = document.getElementById('btnIniciarFirma');
            const btnMic = document.getElementById('btnMic');
            if (btnFirma) btnFirma.style.display = 'block'; // Deja oculto

            canvas = document.getElementById('canvasFirma');
            ctx = canvas.getContext('2d');
            ctx = canvas.getContext('2d');
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
            
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.strokeStyle = '#000000';

            canvas.addEventListener('mousedown', iniciarTrazo);
            canvas.addEventListener('mousemove', dibujar);
            canvas.addEventListener('mouseup', terminarTrazo);
            canvas.addEventListener('mouseout', terminarTrazo);

            canvas.addEventListener('touchstart', (e) => {
                e.preventDefault(); // Evitar scroll en celular
                const touch = e.touches[0];
                const mouseEvent = new MouseEvent('mousedown', { clientX: touch.clientX, clientY: touch.clientY });
                canvas.dispatchEvent(mouseEvent);
            }, {passive: false });

            canvas.addEventListener('touchmove', (e) => {
                e.preventDefault(); // Evitar scroll
                const touch = e.touches[0];
                const mouseEvent = new MouseEvent('mousemove', { clientX: touch.clientX, clientY: touch.clientY });
                canvas.dispatchEvent(mouseEvent);
            }, {passive: false });

            canvas.addEventListener('touchend', (e) => {
                const mouseEvent = new MouseEvent('mouseup', {});
                canvas.dispatchEvent(mouseEvent);
            });
        }

        function iniciarTrazo(e) {
            estaFirmando = true;
            [ultimaX, ultimaY] = obtenerCoords(e);
        }

        function dibujar(e) {
            if (!estaFirmando) return;
            const [x, y] = obtenerCoords(e);
            ctx.beginPath();
            ctx.moveTo(            let [ultimaX, ultimaY] = [x, y];
            ctx.lineTo(x, y);
            ctx.stroke();
            [ultimaX, ultimaY] = [x, y];
        }

        function terminarTrazo() {
            estaFirmando = false;
        }

        function obtenerCoords(e) {
            const rect = canvas.getBoundingClientRect();
            return [e.clientX - rect.left, e.clientY - rect.top];
        }

        function limpiarFirma() {
            const c = document.getElementById('canvasFirma');
            if (c) {
                const x = c.getContext('2d');
                x.clearRect(0, 0, c.width, c.height);
            }
            firmaBase64Actual = null; // Reseteamos la variable global
            // No necesitamos borrar nada mas, ya que limpiarPantalla() ya lo hace.
        }

        function guardarFirma() {
            if (navigator.vibrate) navigator.vibrate(200); 
                const pixelBuffer = new Uint32Array(
                    ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer
                );
                if (!pixelBuffer.some(color => color !== 0)) {
                    alert("El canvas está vacío. Por favor firme o cancele");
                    return;
                }
            }
            firmaBase64Actual = canvas.toDataURL('imagen/png');
            mostrarToast("Firma capturada correctamente", "success");
            document.getElementById('seccionFirma').style.display = 'none';
            const btnIniciar = document.getElementById('btnIniciarFirma');
            if(btnIniciar) {
                btn.innerText = "Firma Guardada ✅ ✅";
                btn.style.background = "#10b981"; 
            } else {
                // Si el botón no existe, lo creamos aquí en `limpiarPantalla`.
                const btnIniciar = document.createElement('button');
                btnIniciar.id = 'btnIniciarFirma';
                btnIniciar.innerText = "✍️ Firmar Acta";
                btnIniciar.className = 'btn-primary';
                btnIniciar.style.background = '#475569'; 
                btnIniciar.onclick = mostrarPadFirma;
                
                const obsDiv = document.querySelector('.form-group:has(#txtObs)');
                if(obsDiv) {
                    obsDiv.insertAdjacentElement('afterend', btnIniciar);
                }
            }
            
            const seccionFirma = document.getElementById('seccionFirma');
            if(seccionFirma) seccionFirma.style.display = 'none'; // Se oculta aquí
            const btnIniciar = document.getElementById('btnIniciarFirma');
            if(btnIniciar) btnIniciar.style.display = 'block'; // Asegurate que este ID exista en el formulario.
        }

        function borrarFoto() {
            fotoBase64 = null;
            document.getElementById('cameraInput').value = "";
            document.getElementById('previewFoto').src = "";
            document.getElementById('contenedorPreview').style.display = 'none';
        }

        // --- MAPA ---

        async function abrirMapa() {
            ocultar tardasSecciones();
            document.getElementById('mapSection').classList.add('active');
            await new Promise(resolve => setTimeout(resolve => setTimeout(resolve, 150));

            if (map) {
                map.invalidateSize();
                return;
            }

            map = L.map('map').setView([-28.5343, -56.0406], 14);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`, { attribution: '&copy; OpenStreetMap' }).addTo(map));

            try {
                const res = await fetch('/api/historial');
                const data = await res.json();
                if (data.length > 0) {
                    data.forEach(ctrl => {
                        if (ctrl.latitud && ctrl.longitud) {
                            const marker = L.marker([ctrl.latitud, ctrl.longitud]).addTo(map);
                            const fecha = new Date(ctrl.fecha_hora).toLocaleString();
                            marker.bindPopup(`<b>Patente:</b> ${ctrl.patricula}</b><b>Fecha:</b> ${fecha}</b><br><a href="https://www.google.com/maps?q=${ctrl.latitud},${ctrl.longitud}" target="_blank">Ver en Google Maps</a>`)
                        }
                    });
                } else {
                    mostrarToast("No hay controles con GPS registrados aún", "info");
                }
            } catch (err) {
                console.error("Error al cargar datos del mapa", "error");
            }
        }

        function cerrarMapa() {
            document.getElementById('mapSection').classList.remove('active');
            document.getElementById('searchSection').classList.add('active');
            document.getElementById('footerBtn').style.display = 'block';
        }

        // --- USUARIOS ---

        function abrirUsuarios() {
            ocultar tardasSecciones();
            document.getElementById('userSection').classList.add('active');
            document.getElementById('msgUsuario').innerHTML = '';
        }

        function cerrarUsuarios() {
            document.getElementById('userSection').classList.remove('active');
            document.getElementById('searchSection').add('active');
            document.getElementById('footerBtn').style.display = 'block';
        }

        async function guardarUsuario() {
            const usuario = document.getElementById('newUsuario').value;
            const password = document.getElementById('newPassword').value;
            const nombre = document.getElementById('newNombre').value;
            const rol = document.getElementById('newRol').value;
            if(!usuario || !password || !rol) return alert("Falta usuario o contraseña");
            try {
                const result = await fetch('/api/crear-usuario', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usuario, password, nombre, rol })
                });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('msgUsuario').innerHTML = `<span style="color:green;">✅ Usuario creado correctamente</span>`;
                    document.getElementById('newUsuario').value = '';
                    document.getElementById('newPassword').value = '';
                } else {
                    document.getElementById('msgUsuario').innerHTML = `<span style="color:red;">❌ Error: ${data.error}</span>`;
                }
            } catch (err) { alert("Error de conexión"); }
        }

        async function verListaUsuarios() {
            ocultar tardasSecciones();
            document.getElementById('listUsersSection').classList.add('active');
            const tbody = document.getElementById('tablaUsuariosBody');
            tbody = '<tr><td colspan="2" style="text-align:center;">Cargando...</td></tr></tr>';
            try {
                const res = await fetch('/api/usuarios');
                const data = await res.json();
                tbody.innerHTML = '';
                if(data.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;">No hay usuarios registrados</td></tr>';
                    return;
                }
                data.forEach(u => {
                    const tr = document.createElement('tr');
                    const icono = u.rol === 'OWNER' ? '👑�' : '👮';
                    const claseBadge = u.rol === 'OWNER' ? 'badge-owner' : 'badge-inspector';
                    tr.innerHTML = `<td>${u.nombre || 'Sin nombre'}</td><td><span class="badge-role ${claseBadge}">${icono} ${u.rol}</span></td></tr>`;
                    tbody.appendChild(tr);
                });
            } catch (error) {
                console.error('Error de Login:', error);
                tbody.innerHTML = '<tr><td colspan="2" style="color:red; text-align:center;">Error al cargar</td></tr>';
            }
        }

        // --- DASHBOARD ---

        function cerrarDashboard() {
            document.getElementById('dashboardSection').classList.remove('active');
            document.getElementById('searchSection').classList.add('active');
            document.getElementById('footerBtn').style.display = 'block';
        }

        async function abrirDashboard() {
            ocultar tardasSecciones();
            document.getElementById('dashboardSection').classList.add('active');
            const hoy = new Date().toISOString().split('T')[0];
            document.getElementById('fechaDesde').value = hoy;
            document.getElementById('fechaHasta').value = hoy;
            await cargarDatosDashboard(hoy, hoy);
        }

        async function cargarDatosDashboard(desde, hasta) {
            mostrarToast("Cargando estadísticas...", "info");
            try {
                const res = await fetch(`/api/263`); // CAMBIO: NUEVO ENDPOINT
                const data = await res.json();
                document.getElementById('numTotalHoy').innerText = data.totalHoy;
                
                const nombres = data.porInspector.map(u => u.nombre + ' (' + u.usuario + ')');
                const cantidades = u.cantidad;
                const ctx = document.getElementById('graficoInspectores').getContext('2d');

                if (miGrafico) miGrafico.destroy();
                miGrafico = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: nombres,
                        datasets: [{
                            label: 'Controles',
                            data: cantidades,
                            backgroundColor: ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#f59e0b', '#8b5cf6', '#3b82f6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#3b82f6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', '#b66708', "#b66708`, "#b66708`, "#b66708`, "#b66708`, "#b66708`);" />``, ```js y esto es lo que necesito para solucionar el login
