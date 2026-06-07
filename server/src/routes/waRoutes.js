const router      = require('express').Router();
const { Op }      = require('sequelize');
const { getQRImage, getStatus, resetAndRestart } = require('../services/whatsappClient');
const { Conversacion, Producto } = require('../models');
const { enviarTexto } = require('../services/whatsappService');
const { procesarMensaje } = require('../services/botService');
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
        // Buscar conversaciones con último mensaje del usuario (últimas 48h)
        const pendientes = await Conversacion.findAll({
            where: {
                updatedAt: { [Op.gt]: new Date(Date.now() - 48 * 60 * 60 * 1000) },
                estado:    { [Op.in]: ['nuevo', 'activo', 'menu'] }
            }
        });

        let respondidos = 0;
        for (const conv of pendientes) {
            const historial = conv.historial || [];
            if (!historial.length) continue;

            // Buscar el último mensaje del usuario (aunque el bot ya haya respondido después)
            const ultimoUser = [...historial].reverse().find(h => h.rol === 'user');
            if (!ultimoUser) continue;

            // Si el bot ya respondió con info específica del producto (audio / link), omitir
            const ultimoBot = [...historial].reverse().find(h => h.rol === 'bot');
            const yaRespondioCorrect = ultimoBot && !ultimoBot.texto?.includes('Escríbeme el número') &&
                                       !ultimoBot.texto?.includes('¿Sigues interesado?') &&
                                       !ultimoBot.texto?.includes('disponible:');
            if (yaRespondioCorrect) continue;

            try {
                await procesarMensaje({
                    numero:      conv.numero_wa,
                    nombre:      conv.nombre_cliente,
                    tipo:        'text',
                    texto:       ultimoUser.texto,
                    mediaBuffer: null
                });
                respondidos++;
                await new Promise(r => setTimeout(r, 2000));
            } catch (e) { console.error('Error respondiendo a', conv.numero_wa, e.message); }
        }

        res.json({ ok: true, respondidos });
    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

// Recuperar clientes activos: resetear flags y mandar mensajes personalizados
router.post('/recuperar-clientes', auth, async (req, res) => {
    res.json({ ok: true, msg: 'Recuperación iniciando...' });
    setTimeout(async () => {
        try {
            const { enviarTexto } = require('../services/whatsappService');
            const delay = ms => new Promise(r => setTimeout(r, ms));

            const todos = await Conversacion.findAll({
                where: { estado: { [Op.in]: ['esperando_comprobante','esperando_email','activo','menu'] } },
                include: [{ model: Producto, as: 'producto', required: false }]
            });

            let enviados = 0;

            for (const conv of todos) {
                const notas    = conv.notas || {};
                const nombre   = (conv.nombre_cliente || '').split(' ')[0] || 'hola';
                const num      = conv.numero_wa;
                const estado   = conv.estado;
                const prod     = conv.producto?.nombre || '';
                const esN8n    = /n8n|agente/i.test(prod);
                const esCapcut = /capcut/i.test(prod);

                // Resetear todos los flags de seguimiento
                const notasLimpias = Object.fromEntries(
                    Object.entries(notas).filter(([k]) => !k.startsWith('seg_'))
                );

                let msg = null;

                if (estado === 'esperando_comprobante') {
                    msg = `Hola ${nombre} 👋 ¿Todo bien con el pago? Si tuviste algún problema o necesitas otro método de pago, cuéntame y lo resolvemos 😊`;

                } else if (estado === 'esperando_email') {
                    // Caso especial: alguien que dijo que no pudo pasar el correo
                    const historial = conv.historial || [];
                    const dijoCorroeProblema = historial.some(h => h.rol === 'user' && /no he podido|no pude|correo/i.test(h.texto));
                    if (dijoCorroeProblema) {
                        msg = `Hola ${nombre} 😊 tranquilo, escríbeme tu correo aquí directamente y te envío el acceso de una ✅`;
                    } else if (esN8n) {
                        const ops = [
                            `Hola ${nombre} 👋 ¿Hay algo del pack de n8n que no quedó claro? Cuéntame 🤖`,
                            `Oye ${nombre}, ¿para qué proceso lo estabas pensando? Así te digo cuál agente te sirve más 💡`
                        ];
                        msg = ops[Math.floor(Math.random() * ops.length)];
                    } else if (esCapcut) {
                        const ops = [
                            `Hola ${nombre} 👋 ¿Le diste ojo al curso de CapCut? Si tienes alguna duda cuéntame 🎬`,
                            `Oye ${nombre}, ¿qué tipo de contenido quieres crear? Así te digo qué parte del curso te ayuda más 📱`
                        ];
                        msg = ops[Math.floor(Math.random() * ops.length)];
                    }

                } else if (['activo','menu'].includes(estado) && prod) {
                    if (esN8n) {
                        msg = `Hola ${nombre} 👋 ¿Pudiste revisar el pack de n8n? Si tienes alguna pregunta de cómo funciona, aquí estoy 😊`;
                    } else if (esCapcut) {
                        msg = `Hola ${nombre} 👋 ¿Le diste ojo al curso de CapCut? Cualquier duda me cuentas 🎬`;
                    }
                }

                if (msg) {
                    try {
                        await enviarTexto(num, msg);
                        await conv.update({ notas: { ...notasLimpias, recuperacion_enviada: Date.now() } });
                        enviados++;
                        await delay(2500);
                    } catch (e) { console.error('Error recuperando', num, e.message); }
                }
            }
            console.log(`[Recuperación] ${enviados} mensajes enviados`);
        } catch (e) { console.error('[Recuperación] Error:', e.message); }
    }, 200);
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

// Enviar mensaje directo a lista de números
router.post('/broadcast', auth, async (req, res) => {
    try {
        const { numeros, mensaje } = req.body;
        if (!numeros?.length || !mensaje) return res.status(400).json({ ok: false, msg: 'numeros y mensaje requeridos' });

        const productos = await Producto.findAll({ where: { activo: true }, order: [['orden', 'ASC']] });
        const lista = productos.map((p, i) => `*${i+1}.* ${p.nombre} — *$${parseInt(p.precio).toLocaleString('es-CO')}*`).join('\n');
        const msgFinal = mensaje.replace('{{lista}}', lista);

        let enviados = 0;
        for (const num of numeros) {
            const numero = num.toString().replace(/\D/g,'');
            try {
                await enviarTexto(numero, msgFinal);
                // Crear conversación en BD para que el bot pueda seguir la charla
                const [conv] = await Conversacion.findOrCreate({
                    where: { numero_wa: numero },
                    defaults: { nombre_cliente: null, estado: 'menu', historial: [], notas: {} }
                });
                const h = [...(conv.historial || []), { rol: 'bot', texto: msgFinal, ts: Date.now() }].slice(-30);
                await conv.update({ historial: h, estado: 'menu' });
                enviados++;
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) { console.error('Error enviando a', numero, e.message); }
        }
        res.json({ ok: true, enviados });
    } catch (e) {
        res.status(500).json({ ok: false, msg: e.message });
    }
});

module.exports = router;
