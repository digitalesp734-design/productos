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

    // Productos — actualizar in-place para evitar FK constraint con Conversaciones
    const datosCapcut = {
        nombre:      'Curso CapCut PRO (Pack Completo)',
        descripcion: 'Pack completo: CapCut PRO + Edición de Video Profesional + Photoshop PRO. Todo para crear contenido viral y profesional. Pago único de por vida.',
        precio:      20000,
        link_drive:  '🎬 *CapCut PRO – Edición desde Cero*\n▪ Aprende a editar videos modernos para redes sociales, reels y contenido viral.\nhttps://drive.google.com/drive/folders/1A5DhrI1pKz1TLq9cyU2U9LI-ROb1g5Es?usp=sharing\n\n🎬 *Edición de Video Profesional*\n▪ Técnicas y flujo de trabajo para editar contenido profesional y comercial.\nhttps://drive.google.com/drive/folders/1MUfFrcti-coGHbJVloFVQ6mEv_1Vph7m\n\n🎨 *Photoshop PRO – Edición Profesional*\n▪ Retoque fotográfico, corrección de color y creación de piezas visuales profesionales.\nhttps://drive.google.com/drive/folders/1X6EZD26FC4I5plBwhpU7ucBnlorlC6pR',
        activo:      true,
        orden:       1
    };
    const datosN8n = {
        nombre:      'Pack n8n — 350 Agentes de IA',
        descripcion: '350 agentes de automatización listos para usar en n8n. Automatiza ventas, atención al cliente, marketing y más. Pago único de por vida.',
        precio:      20000,
        link_drive:  'https://drive.google.com/drive/folders/191XWRGRXJmLCaULa2lLp4G_QXf63oesw?usp=sharing',
        activo:      true,
        orden:       2
    };

    const datosCombo = {
        nombre:      'Combo CapCut PRO + Pack Recursos de Edición',
        descripcion: 'El curso completo de CapCut PRO + Pack Recursos de Edición (vectores, efectos, plantillas, todo). Pago único de por vida.',
        precio:      35000,
        link_drive:  '🎬 *CapCut PRO – Edición desde Cero*\n▪ Aprende a editar videos modernos para redes sociales, reels y contenido viral.\nhttps://drive.google.com/drive/folders/1A5DhrI1pKz1TLq9cyU2U9LI-ROb1g5Es?usp=sharing\n\n🎬 *Edición de Video Profesional*\n▪ Técnicas y flujo de trabajo para editar contenido profesional y comercial.\nhttps://drive.google.com/drive/folders/1MUfFrcti-coGHbJVloFVQ6mEv_1Vph7m\n\n🎨 *Photoshop PRO – Edición Profesional*\n▪ Retoque fotográfico, corrección de color y creación de piezas visuales profesionales.\nhttps://drive.google.com/drive/folders/1X6EZD26FC4I5plBwhpU7ucBnlorlC6pR\n\n🎯 *Pack Recursos de Edición Completo*\n▪ Vectores, efectos, plantillas y todo lo que necesitas para crear contenido profesional.\nhttps://drive.google.com/drive/folders/1d3b_9i-a0HGjg_ymgNjAmzzy39WRUVEj',
        activo:      true,
        orden:       2
    };

    let capcut = await Producto.findOne({ where: { nombre: 'Curso CapCut PRO (Pack Completo)' } });
    if (!capcut) {
        const viejo = await Producto.findOne({ where: sequelize.literal("nombre LIKE '%apcut%' AND nombre NOT LIKE '%ombo%'") });
        if (viejo) { await viejo.update(datosCapcut); capcut = viejo; }
        else        { capcut = await Producto.create(datosCapcut); }
        console.log('✅ Producto CapCut actualizado/creado');
    }

    let combo = await Producto.findOne({ where: { nombre: 'Combo CapCut PRO + Pack Recursos de Edición' } });
    if (!combo) {
        combo = await Producto.create(datosCombo);
        console.log('✅ Combo CapCut + Recursos creado');
    }

    let n8n = await Producto.findOne({ where: { nombre: 'Pack n8n — 350 Agentes de IA' } });
    if (!n8n) {
        const viejo = await Producto.findOne({ where: sequelize.literal("nombre LIKE '%n8n%' OR nombre LIKE '%gente%'") });
        if (viejo) { await viejo.update(datosN8n); n8n = viejo; }
        else        { n8n = await Producto.create(datosN8n); }
        console.log('✅ Producto n8n actualizado/creado');
    }

    // Pack n8n Premium: curso desde cero + hosting gratuito en la nube
    const datosN8nPremium = {
        nombre:      'Pack n8n Premium — Curso + Hosting Gratis',
        descripcion: '350 agentes listos + Curso completo n8n desde cero hasta profesional + instalación y hosting de n8n en la nube 100% GRATIS. Todo incluido, pago único de por vida.',
        precio:      35000,
        link_drive:  'https://drive.google.com/drive/folders/191XWRGRXJmLCaULa2lLp4G_QXf63oesw?usp=sharing',
        activo:      true,
        orden:       3
    };
    let n8nPremium = await Producto.findOne({ where: { nombre: 'Pack n8n Premium — Curso + Hosting Gratis' } });
    if (!n8nPremium) {
        n8nPremium = await Producto.create(datosN8nPremium);
        console.log('✅ Pack n8n Premium creado');
    }

    const datosEmuladora = {
        nombre:      'EmulaConsolas — 16.000 Juegos',
        descripcion: 'Accede a más de 16.000 juegos de 32 consolas: PlayStation, Xbox, Nintendo y más. 100% digital, instálalo en tu PC, tablet o celular. Pago único de por vida.',
        precio:      15000,
        link_drive:  '🎮 *¡Gracias por tu compra del EmulaConsolas!* 🙌\nIngresa al siguiente archivo 📁 para acceder a toda la información, instrucciones y contenido completo del producto.\n\n*1. Cómo descargarlo:*\n🎥 https://www.youtube.com/watch?v=jrUssqaLNcM\n📥 Enlace de descarga: https://uploadnow.io/es/share?utm_source=8mQlmkG\n🔑 Contraseña: StaRsEmulaConsola!\n\n*2. Cómo agregar juegos de PS1:*\nhttps://www.youtube.com/watch?v=47nIVTbf5C4\n\n*3. Cómo agregar juegos de PS2:*\nhttps://www.youtube.com/watch?v=jScX8nNikmQ\n\n*4. Cómo agregar juegos de PS3:*\nhttps://www.youtube.com/watch?v=CS3fwJzVrYw\n\n*5. Cómo agregar juegos de PC:*\nhttps://www.youtube.com/watch?v=8JH6KgqU86w\n\n*6. Posibles errores:*\nhttps://www.youtube.com/watch?v=M_xAoLjDCE8',
        activo:      true,
        orden:       5
    };

    let emuladora = await Producto.findOne({ where: { nombre: 'EmulaConsolas — 16.000 Juegos' } });
    if (!emuladora) {
        emuladora = await Producto.create(datosEmuladora);
        console.log('✅ Producto EmulaConsolas creado');
    } else if (parseInt(emuladora.precio) !== datosEmuladora.precio) {
        await emuladora.update({ precio: datosEmuladora.precio });
        console.log(`✅ Precio EmulaConsolas actualizado a $${datosEmuladora.precio.toLocaleString()}`);
    }

    // Limpiar productos extra (mantener solo los 5 correctos)
    if (capcut && combo && n8n && n8nPremium && emuladora) {
        await sequelize.query(`UPDATE Conversacions SET producto_id = NULL WHERE producto_id NOT IN (${capcut.id}, ${combo.id}, ${n8n.id}, ${n8nPremium.id}, ${emuladora.id})`);
        const [deleted] = await sequelize.query(`DELETE FROM Productos WHERE id NOT IN (${capcut.id}, ${combo.id}, ${n8n.id}, ${n8nPremium.id}, ${emuladora.id})`);
        if (deleted?.affectedRows > 0) console.log(`🗑️ Eliminados ${deleted.affectedRows} productos extra`);
    }
}

const PORT = process.env.PORT || 3000;

async function iniciar(intentos = 5) {
    for (let i = 1; i <= intentos; i++) {
        try {
            await sequelize.authenticate();
            await sequelize.sync();
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
