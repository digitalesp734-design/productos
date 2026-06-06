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

    // Productos — verificar nombre exacto para evitar que productos viejos bloqueen el seed
    const tieneCapcut = await Producto.findOne({ where: { nombre: 'Curso CapCut PRO (Pack Completo)' } });
    const tieneN8n    = await Producto.findOne({ where: { nombre: 'Pack n8n — 350 Agentes de IA' } });

    if (!tieneCapcut || !tieneN8n) {
        await Producto.destroy({ where: {} }); // limpiar seed incorrecto
        await Producto.bulkCreate([
            {
                nombre:      'Curso CapCut PRO (Pack Completo)',
                descripcion: 'Pack completo: CapCut PRO + Edición de Video Profesional + Photoshop PRO. Todo para crear contenido viral y profesional. Pago único de por vida.',
                precio:      20000,
                link_drive:  '🎬 *CapCut PRO – Edición desde Cero*\n▪ Aprende a editar videos modernos para redes sociales, reels y contenido viral.\nhttps://drive.google.com/drive/folders/1A5DhrI1pKz1TLq9cyU2U9LI-ROb1g5Es?usp=sharing\n\n🎬 *Edición de Video Profesional*\n▪ Técnicas y flujo de trabajo para editar contenido profesional y comercial.\nhttps://drive.google.com/drive/folders/1MUfFrcti-coGHbJVloFVQ6mEv_1vPh7m\n\n🎨 *Photoshop PRO – Edición Profesional*\n▪ Retoque fotográfico, corrección de color y creación de piezas visuales profesionales.\nhttps://drive.google.com/drive/folders/1X6EZD26FC4I5plBwhpU7ucBnlorlC6pR',
                activo:      true,
                orden:       1
            },
            {
                nombre:      'Pack n8n — 350 Agentes de IA',
                descripcion: '350 agentes de automatización listos para usar en n8n. Automatiza ventas, atención al cliente, marketing y más. Pago único de por vida.',
                precio:      20000,
                link_drive:  'https://drive.google.com/drive/folders/191XWRGRXJmLCaULa2lLp4G_QXf63oesw?usp=sharing',
                activo:      true,
                orden:       2
            }
        ]);
        console.log('✅ Productos creados (Curso CapCut Pack Completo + Pack n8n)');
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
