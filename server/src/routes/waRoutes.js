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
                estado:    { [Op.in]: ['nuevo', 'viendo_producto', 'menu'] }
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
                where: { estado: { [Op.in]: ['esperando_comprobante','esperando_email','viendo_producto','menu'] } },
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
                const esEmula  = /emula/i.test(prod);

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

                } else if (['viendo_producto','menu'].includes(estado) && prod) {
                    if (esN8n) {
                        msg = `Hola ${nombre} 👋 ¿Pudiste revisar el pack de n8n? Si tienes alguna pregunta de cómo funciona, aquí estoy 😊`;
                    } else if (esCapcut) {
                        msg = `Hola ${nombre} 👋 ¿Le diste ojo al curso de CapCut? Cualquier duda me cuentas 🎬`;
                    } else if (esEmula) {
                        msg = `Hola ${nombre} 👋 ¿Pudiste ver el catálogo de juegos? Si tienes alguna duda de compatibilidad o instalación, cuéntame 🎮`;
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

// Broadcast de oferta especial a leads pendientes
router.post('/broadcast-oferta', auth, async (req, res) => {
    try {
        const { descuento } = req.body; // ej: { descuento: 2000 } = $2.000 de descuento
        res.json({ ok: true, msg: 'Broadcast de oferta iniciando...' });
        setTimeout(async () => {
            const { Op } = require('sequelize');
            const { enviarTexto } = require('../services/whatsappService');
            const delay = ms => new Promise(r => setTimeout(r, ms));
            let enviados = 0;

            const pendientes = await Conversacion.findAll({
                where: {
                    estado: { [Op.in]: ['viendo_producto', 'menu', 'esperando_email'] },
                    updatedAt: { [Op.gt]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
                },
                include: [{ model: Producto, as: 'producto', required: false }]
            });

            for (const conv of pendientes) {
                const notas  = conv.notas || {};
                if (notas.oferta_enviada) continue;
                const nombre = (conv.nombre_cliente || '').split(' ')[0] || 'hola';
                const prod   = conv.producto;
                const desc   = descuento || 2000;
                let msg = null;

                if (prod) {
                    const precioOferta = parseInt(prod.precio) - desc;
                    const fmt = p => `$${parseInt(p).toLocaleString('es-CO')}`;
                    const esCapcut = /capcut/i.test(prod.nombre) && !/combo/i.test(prod.nombre);
                    const esN8n    = /n8n/i.test(prod.nombre);
                    const esEmula  = /emula/i.test(prod.nombre);

                    if (esCapcut) {
                        msg = `Hola ${nombre} 👋 Te escribo porque esta semana tenemos el pack CapCut en ${fmt(precioOferta)} (normalmente ${fmt(prod.precio)}). Si lo confirmas hoy te lo dejo a ese precio. ¿Lo tomamos? 🎬`;
                    } else if (esN8n) {
                        msg = `Hola ${nombre} 👋 Por los primeros en confirmar esta semana, el pack de n8n queda en ${fmt(precioOferta)}. Son 350 agentes de por vida — ¿te animas? 🤖`;
                    } else if (esEmula) {
                        msg = `Hola ${nombre} 👋 Esta semana el pack de consolas está en ${fmt(precioOferta)} (normalmente ${fmt(prod.precio)}). +16.000 juegos de por vida. ¿Lo tomamos? 🎮`;
                    }
                } else {
                    msg = `Hola ${nombre} 👋 Esta semana tenemos una oferta especial en nuestros productos digitales. ¿Cuál te interesaba más — CapCut, automatizaciones n8n o la emuladora de juegos? 😊`;
                }

                if (msg) {
                    try {
                        await enviarTexto(conv.numero_wa, msg);
                        await conv.update({ notas: { ...notas, oferta_enviada: Date.now() } });
                        enviados++;
                        await delay(3000);
                    } catch (e) { console.error('Error oferta a', conv.numero_wa, e.message); }
                }
            }
            console.log(`[Oferta] ${enviados} mensajes enviados`);
        }, 300);
    } catch (e) {
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
                // Buscar conversación existente (puede tener formato @lid)
                const conv = await Conversacion.findOne({
                    where: { numero_wa: { [Op.like]: `%${numero}%` } }
                });
                if (conv) {
                    const h = [...(conv.historial || []), { rol: 'bot', texto: msgFinal, ts: Date.now() }].slice(-30);
                    await conv.update({ historial: h, ultimo_mensaje: msgFinal.slice(0, 200) });
                }
                enviados++;
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) { console.error('Error enviando a', numero, e.message); }
        }
        res.json({ ok: true, enviados });
    } catch (e) {
        res.status(500).json({ ok: false, msg: e.message });
    }
});

// Subir comprobantes de prueba social al volumen de Railway
router.post('/subir-comprobantes', auth, async (req, res) => {
    try {
        const fs   = require('fs');
        const path = require('path');
        const volumen = process.env.WA_AUTH_FOLDER;
        if (!volumen) return res.status(400).json({ ok: false, msg: 'WA_AUTH_FOLDER no configurado' });
        const destDir = path.join(volumen, 'comprobantes');
        fs.mkdirSync(destDir, { recursive: true });
        const srcDir = path.join(__dirname, '../assets/comprobantes');
        if (!fs.existsSync(srcDir)) return res.status(404).json({ ok: false, msg: 'Carpeta assets/comprobantes no existe' });
        const archivos = fs.readdirSync(srcDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
        archivos.forEach(f => fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f)));
        res.json({ ok: true, copiados: archivos.length, archivos });
    } catch (e) {
        res.status(500).json({ ok: false, msg: e.message });
    }
});

// Subir video de EmulaConsolas al volumen de Railway (evita tenerlo en git)
router.post('/subir-video', auth, async (req, res) => {
    try {
        const fs   = require('fs');
        const path = require('path');
        const volumen = process.env.WA_AUTH_FOLDER;
        if (!volumen) return res.status(400).json({ ok: false, msg: 'WA_AUTH_FOLDER no configurado' });
        const destino = path.join(volumen, 'emuladora_catalogo.mp4');
        const fuente  = path.join(__dirname, '../assets/videos/emuladora_catalogo.mp4');
        if (!fs.existsSync(fuente)) return res.status(404).json({ ok: false, msg: 'Video no encontrado en assets' });
        fs.copyFileSync(fuente, destino);
        const stats = fs.statSync(destino);
        res.json({ ok: true, msg: 'Video copiado al volumen', tamano: `${(stats.size / 1024 / 1024).toFixed(1)}MB`, ruta: destino });
    } catch (e) {
        res.status(500).json({ ok: false, msg: e.message });
    }
});

// Anunciar nuevo precio de EmulaConsolas a todos los que preguntaron
router.post('/broadcast-precio-emula', auth, async (req, res) => {
    res.json({ ok: true, msg: 'Broadcast precio emula iniciando...' });
    setTimeout(async () => {
        try {
            const { Op } = require('sequelize');
            const { enviarTexto } = require('../services/whatsappService');
            const delay = ms => new Promise(r => setTimeout(r, ms));

            const emula = await Producto.findOne({ where: { nombre: { [Op.like]: '%mula%' } } });
            if (!emula) { console.log('[broadcast-precio-emula] Producto no encontrado'); return; }

            // Buscar por producto_id directo + filtrar historial en JS
            const todas = await Conversacion.findAll({
                where: {
                    updatedAt: { [Op.gt]: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
                    estado: { [Op.ne]: 'completado' }
                }
            });

            const convs = todas.filter(conv =>
                conv.producto_id === emula.id ||
                (conv.historial || []).some(h => /emula|juego|consola|playstation|xbox|nintendo|emulador/i.test(h.texto || ''))
            );

            const fmt = p => `$${parseInt(p).toLocaleString('es-CO')}`;
            let enviados = 0;
            for (const conv of convs) {
                const nombre = (conv.nombre_cliente || '').split(' ')[0] || 'hola';
                const msg = `Hola ${nombre} 👋 Te aviso que bajamos el precio del pack de consolas a *${fmt(emula.precio)}* de por vida 🎉\n\n+16.000 juegos: PS1, PS2, PS3, Xbox, Nintendo, GBA y más. ¿Lo tomamos hoy? 🎮`;
                try {
                    await enviarTexto(conv.numero_wa, msg);
                    const h = [...(conv.historial || []), { rol: 'bot', texto: msg, ts: Date.now() }].slice(-30);
                    await conv.update({ historial: h, ultimo_mensaje: msg.slice(0, 200) });
                    enviados++;
                    await delay(3000);
                } catch (e) { console.error('[broadcast-precio-emula] Error a', conv.numero_wa, e.message); }
            }
            console.log(`[broadcast-precio-emula] ${enviados} mensajes enviados`);
        } catch (e) { console.error('[broadcast-precio-emula] Error general:', e.message); }
    }, 300);
});

// Limpiar conversaciones duplicadas sin @ en numero_wa
router.post('/limpiar-duplicados', auth, async (req, res) => {
    try {
        const duplicados = await Conversacion.findAll({
            where: { numero_wa: { [Op.notLike]: '%@%' } }
        });
        const ids = duplicados.map(c => c.id);
        if (ids.length) await Conversacion.destroy({ where: { id: ids } });
        res.json({ ok: true, eliminados: ids.length });
    } catch (e) {
        res.status(500).json({ ok: false, msg: e.message });
    }
});

module.exports = router;
