require('dotenv').config();

process.on('uncaughtException',  e => console.error('CRASH:', e.message));
process.on('unhandledRejection', e => console.error('CRASH:', e?.message || e));

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const sequelize = require('./config/db');
const { Usuario, Producto } = require('./models');

const waClient = require('./services/whatsappClient');
const { iniciarFollowUpService }       = require('./services/followUpService');
const { iniciarTelegramReportService } = require('./services/telegramReportService');

const app    = express();
const isProd = process.env.NODE_ENV === 'production';

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
app.use(cors({
    origin: (origin, cb) => {
        if (!origin || !isProd) return cb(null, true);
        if (origin === allowedOrigin) return cb(null, true);
        cb(new Error('CORS: origen no permitido'));
    },
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir frontend compilado
const clientDist = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
}

app.get('/api/health', (_, res) => res.json({ ok: true, sistema: 'Product Digital' }));
app.use('/api', require('./routes/index'));

if (fs.existsSync(clientDist)) {
    app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use((err, req, res, next) => {
    if (err.message?.includes('CORS')) return res.status(403).json({ ok: false, msg: 'Origen no permitido' });
    console.error('Error:', err.message);
    res.status(500).json({ ok: false, msg: isProd ? 'Error interno' : err.message });
});

// ── Seed inicial ──────────────────────────────────────────────────────────────
async function seed() {
    // Admin
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        const existe = await Usuario.findOne({ where: { email: process.env.ADMIN_EMAIL } });
        if (!existe) {
            const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
            await Usuario.create({ nombre: 'Administrador', email: process.env.ADMIN_EMAIL, password: hash, rol: 'admin' });
            console.log(`✅ Admin creado: ${process.env.ADMIN_EMAIL}`);
        }
    }

    // Productos iniciales
    const count = await Producto.count();
    if (count === 0) {
        await Producto.bulkCreate([
            { nombre: 'Suite Adobe 2023 Completa', descripcion: 'Todos los programas de Adobe versión 2023: Photoshop, Illustrator, Premiere, After Effects, Lightroom, InDesign y más. ⚠️ Importante: son programas versión 2023, los más estables y completos del mercado. Pago único de por vida, sin mensualidades.', precio: 20000, link_drive: 'PENDIENTE_CONFIGURAR', activo: true, orden: 1 },
            { nombre: 'Cursos Digitales (Ecommerce, Dropshipping, Trading, Marketing)', descripcion: 'Pack completo de cursos en los temas más rentables: Ecommerce, Dropshipping, Trading y Marketing Digital. Todo actualizado y listo para aplicar desde el día uno.', precio: 25000, link_drive: 'PENDIENTE_CONFIGURAR', activo: true, orden: 2 },
            { nombre: 'Consola de Juegos Digitales', descripcion: 'Acceso a una amplia biblioteca de juegos digitales. Pago único de por vida, sin mensualidades ni suscripciones.', precio: 30000, link_drive: 'PENDIENTE_CONFIGURAR', activo: true, orden: 3 },
            { nombre: 'Recursos de Edición (Video + Foto)', descripcion: 'Carpeta completa con recursos premium para edición de video y foto: LUTs, presets, overlays, plantillas, transiciones, efectos de sonido y mucho más.', precio: 20000, link_drive: 'PENDIENTE_CONFIGURAR', activo: true, orden: 4 },
            { nombre: 'Plantillas n8n (+1000 Plantillas)', descripcion: 'Más de 1000 plantillas de automatización listas para usar en n8n. Ahorra cientos de horas de trabajo con flujos ya creados para marketing, ventas, productividad y más.', precio: 15000, link_drive: 'PENDIENTE_CONFIGURAR', activo: true, orden: 5 },
            { nombre: 'Curso de Canva para Principiantes', descripcion: 'Aprende Canva desde cero y crea diseños profesionales para redes sociales, presentaciones, logos y más. Perfecto para emprendedores y editores que están comenzando.', precio: 20000, link_drive: 'PENDIENTE_CONFIGURAR', activo: true, orden: 6 },
            { nombre: 'COMBO: Suite Adobe + Recursos Edición', descripcion: 'El combo perfecto para editores: Suite Adobe 2023 completa + Pack de recursos de edición (LUTs, presets, plantillas y más). Todo por un precio especial.', precio: 35000, link_drive: 'PENDIENTE_CONFIGURAR', activo: true, orden: 7, es_combo: true },
        ]);
        console.log('✅ Productos iniciales creados');
    }
}

const PORT = process.env.PORT || 3000;

async function iniciar(intentos = 5) {
    for (let i = 1; i <= intentos; i++) {
        try {
            await sequelize.authenticate();
            await sequelize.sync({ alter: true });
            await seed();
            app.listen(PORT, '0.0.0.0', () => console.log(`🛒 Product Digital corriendo en puerto ${PORT}`));
            waClient.iniciar();
            iniciarFollowUpService();
            iniciarTelegramReportService();
            return;
        } catch (err) {
            console.error(`Intento ${i}/${intentos}: ${err.message}`);
            if (i === intentos) process.exit(1);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

iniciar();
