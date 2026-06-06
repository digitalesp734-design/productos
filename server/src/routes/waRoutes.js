const router      = require('express').Router();
const { Op }      = require('sequelize');
const { getQRImage, getStatus, resetAndRestart } = require('../services/whatsappClient');
const { Conversacion, Producto } = require('../models');
const { enviarTexto } = require('../services/whatsappService');
const auth        = require('../middleware/auth');

router.get('/status', auth, async (req, res) => {
    const status = getStatus();
    const qrImage = await getQRImage();
    res.json({ ok: true, status, qrImage });
});

router.post('/restart', auth, async (req, res) => {
    res.json({ ok: true, mensaje: 'Reiniciando WhatsApp — el QR aparecerá en unos segundos' });
    // Ejecutar después de responder para no bloquear
    setTimeout(() => resetAndRestart().catch(console.error), 200);
});

// Responder a todos los que están esperando respuesta
router.post('/responder-pendientes', auth, async (req, res) => {
    try {
        const productos = await Producto.findAll({ where: { activo: true }, order: [['orden', 'ASC']] });
        const lista = productos.map((p, i) => `*${i+1}.* ${p.nombre} — *$${parseInt(p.precio).toLocaleString('es-CO')}*`).join('\n');

        // Buscar conversaciones sin respuesta reciente del bot
        const pendientes = await Conversacion.findAll({
            where: {
                updatedAt: { [Op.gt]: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                estado:    { [Op.in]: ['nuevo', 'activo', 'menu'] }
            }
        });

        let respondidos = 0;
        for (const conv of pendientes) {
            const historial = conv.historial || [];
            if (!historial.length) continue;

            // Revisar si el último mensaje fue del usuario
            const ultimo = historial[historial.length - 1];
            if (ultimo?.rol !== 'user') continue;

            const msg = `Hola 👋 ¿Sigues interesado?\n\nTengo esto disponible:\n\n${lista}\n\nEscríbeme el número del que te interesa 😊`;
            await enviarTexto(conv.numero_wa, msg);
            const h = [...historial, { rol: 'bot', texto: msg, ts: Date.now() }].slice(-30);
            await conv.update({ historial: h, ultimo_mensaje: msg.slice(0, 200) });
            respondidos++;
            await new Promise(r => setTimeout(r, 800)); // esperar entre mensajes
        }

        res.json({ ok: true, respondidos });
    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

// Disparar seguimientos manualmente
router.post('/followup-ahora', auth, async (req, res) => {
    try {
        const { ejecutarSeguimientos } = require('../services/followUpService');
        res.json({ ok: true, msg: 'Seguimientos ejecutando...' });
        setTimeout(() => ejecutarSeguimientos().catch(console.error), 100);
    } catch (e) {
        res.status(500).json({ ok: false, msg: e.message });
    }
});

module.exports = router;
