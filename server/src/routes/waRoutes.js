const router      = require('express').Router();
const { Op }      = require('sequelize');
const { getQRImage, getStatus, resetAndRestart } = require('../services/whatsappClient');
const { Conversacion, Producto } = require('../models');
const { enviarTexto } = require('../services/whatsappService');
const { procesarMensaje, getProductos, detectarProductoMencionado, enviarDetalleProducto, guardarHistorial, fmt } = require('../services/botService');
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

// FORZAR respuesta a TODOS los que quedaron colgados: re-procesa el último mensaje
// del cliente en conversaciones activas recientes (aunque el bot "ya haya respondido" en BD).
router.post('/responder-todos', auth, async (req, res) => {
    res.json({ ok: true, msg: 'Respondiendo a todos los pendientes...' });
    setTimeout(async () => {
        try {
            const horas = parseInt(req.body && req.body.horas) || 12;
            const desde = new Date(Date.now() - horas * 60 * 60 * 1000);
            const convs = await Conversacion.findAll({
                where: {
                    updatedAt: { [Op.gt]: desde },
                    estado: { [Op.in]: ['nuevo','viendo_producto','menu','esperando_email','esperando_comprobante'] }
                },
                order: [['updatedAt','ASC']]
            });
            let respondidos = 0, saltados = 0;
            for (const conv of convs) {
                const historial = conv.historial || [];
                const ultimoUser = [...historial].reverse().find(h => h.rol === 'user');
                if (!ultimoUser || !ultimoUser.texto) { saltados++; continue; }
                // Si el cliente fue el último en escribir O el bot respondió pero pudo no entregarse → re-responder
                try {
                    await procesarMensaje({
                        numero:      conv.numero_wa,
                        nombre:      conv.nombre_cliente,
                        tipo:        'text',
                        texto:       ultimoUser.texto,
                        mediaBuffer: null
                    });
                    respondidos++;
                    await new Promise(r => setTimeout(r, 4000)); // 4s entre cada uno: no saturar
                } catch (e) { console.error('[responder-todos]', conv.numero_wa, e.message); }
            }
            console.log(`[responder-todos] ${respondidos} respondidos, ${saltados} saltados`);
            try {
                const { notificarTelegram } = require('../services/botService');
                await notificarTelegram(`✅ Respondí a ${respondidos} clientes que estaban esperando.`);
            } catch {}
        } catch (e) { console.error('[responder-todos] error:', e.message); }
    }, 200);
});

// RECUPERAR LEADS DE ANUNCIOS mal atendidos: busca conversaciones donde el bot
// respondió genérico (no envió la info del producto) y, detectando el producto en
// TODO el historial del cliente, les manda el audio/video + info + precio correctos.
// body: { horas: 72, ejecutar: false }  → ejecutar:false = solo lista (no envía nada).
router.post('/recuperar-anuncios', auth, async (req, res) => {
    try {
        const horas    = parseInt(req.body && req.body.horas) || 72;
        const ejecutar = !!(req.body && req.body.ejecutar);
        const desde    = new Date(Date.now() - horas * 60 * 60 * 1000);
        const productos = await getProductos();

        const convs = await Conversacion.findAll({
            where: {
                updatedAt: { [Op.gt]: desde },
                estado: { [Op.in]: ['nuevo', 'menu', 'viendo_producto'] }
            },
            order: [['updatedAt', 'ASC']]
        });

        // ¿El bot ya le envió el DETALLE de un producto? (marcador "🔥 nombre")
        const yaRecibioDetalle = (hist) => (hist || []).some(h =>
            h.rol === 'bot' && typeof h.texto === 'string' && h.texto.startsWith('🔥 '));

        // Detecta producto en TODOS los mensajes del cliente (no solo el último)
        const detectarEnHistorial = (hist) => {
            const msgs = (hist || []).filter(h => h.rol === 'user' && h.texto)
                .map(h => String(h.texto).toLowerCase());
            for (const txt of msgs.reverse()) {       // del más reciente al más viejo
                const p = detectarProductoMencionado(txt, productos, null);
                if (p) return p;
            }
            return null;
        };

        // Sube al de mayor valor (igual que procesarMensaje), salvo que pida básico
        const aplicarUpsell = (prod, hist) => {
            const txt = (hist || []).filter(h => h.rol === 'user' && h.texto)
                .map(h => String(h.texto).toLowerCase()).join(' ');
            const quiereBasico = /b[aá]sico|solo el curso|economico|econ[oó]mico|barato|ya manejo|ya s[eé] usar|ya uso n8n/.test(txt);
            if (quiereBasico) return prod;
            if (/capcut/i.test(prod.nombre) && !/combo/i.test(prod.nombre)) {
                const c = productos.find(p => /combo/i.test(p.nombre)); if (c) return c;
            } else if (/n8n|agente/i.test(prod.nombre) && !/premium/i.test(prod.nombre)) {
                const pr = productos.find(p => /premium/i.test(p.nombre) && /n8n/i.test(p.nombre)); if (pr) return pr;
            }
            return prod;
        };

        const plan = [];
        for (const conv of convs) {
            const hist = conv.historial || [];
            if (yaRecibioDetalle(hist)) { plan.push({ numero: conv.numero_wa, nombre: conv.nombre_cliente, accion: 'omitir-ya-atendido' }); continue; }
            let prod = detectarEnHistorial(hist);
            if (prod) prod = aplicarUpsell(prod, hist);
            plan.push({
                numero:   conv.numero_wa,
                nombre:   conv.nombre_cliente || '',
                estado:   conv.estado,
                producto: prod ? prod.nombre : null,
                accion:   prod ? 'enviar-detalle' : 're-enganche-humano',
                _conv:    conv,
                _prod:    prod
            });
        }

        if (!ejecutar) {
            // DRY RUN: solo mostrar el plan, sin enviar nada
            return res.json({
                ok: true, dryRun: true, total: plan.length,
                conDetalle:  plan.filter(p => p.accion === 'enviar-detalle').length,
                reEnganche:  plan.filter(p => p.accion === 're-enganche-humano').length,
                yaAtendidos: plan.filter(p => p.accion === 'omitir-ya-atendido').length,
                plan: plan.map(({ _conv, _prod, ...p }) => p)
            });
        }

        // EJECUTAR: enviar en segundo plano, con pausa entre cada uno
        res.json({ ok: true, ejecutando: true, total: plan.filter(p => p._conv).length });
        setTimeout(async () => {
            let enviados = 0, enganches = 0;
            for (const item of plan) {
                if (!item._conv) continue;
                const conv = item._conv;
                try {
                    if (item.accion === 'enviar-detalle' && item._prod) {
                        await conv.update({ estado: 'viendo_producto', producto_id: item._prod.id });
                        await guardarHistorial(conv, 'bot', `🔥 ${item._prod.nombre} — ${fmt(item._prod.precio)}`);
                        await enviarDetalleProducto(conv.numero_wa, item._prod);
                        enviados++;
                    } else if (item.accion === 're-enganche-humano') {
                        const nombre = (conv.nombre_cliente || '').split(' ')[0];
                        const saludo = nombre ? `¡Hola ${nombre}! 🙌` : '¡Hola! 🙌';
                        const msg = `${saludo} Soy Cristian. Vi que me escribiste por el anuncio y no alcancé a responderte bien, mil disculpas 🙏\n\n¿Era por la *emuladora* de juegos 🎮, el *CapCut PRO* para editar 🎬 o los *agentes de IA con n8n* 🤖? Cuéntame y te paso todo al toque.`;
                        await enviarTexto(conv.numero_wa, msg);
                        await guardarHistorial(conv, 'bot', msg);
                        enganches++;
                    }
                    await new Promise(r => setTimeout(r, 5000)); // 5s entre cada cliente
                } catch (e) { console.error('[recuperar-anuncios]', conv.numero_wa, e.message); }
            }
            console.log(`[recuperar-anuncios] ${enviados} con info de producto, ${enganches} re-enganches`);
            try {
                const { notificarTelegram } = require('../services/botService');
                await notificarTelegram(`📣 Recuperación de anuncios: envié info de producto a ${enviados} y re-enganché a ${enganches} leads.`);
            } catch {}
        }, 200);

    } catch (e) {
        console.error('[recuperar-anuncios] error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// DIAGNÓSTICO: devuelve la estructura del último mensaje CTWA cuyo texto no se pudo extraer.
router.get('/raw-msg', auth, async (req, res) => {
    try {
        const { getUltimoMsgRaw } = require('../services/whatsappClient');
        const raw = getUltimoMsgRaw();
        if (!raw) return res.json({ ok: true, vacio: true, msg: 'Aún no hay mensaje sin texto capturado' });
        res.json({ ok: true, jid: raw.jid, nombre: raw.nombre, hace_seg: Math.round((Date.now()-raw.ts)/1000), claves: Object.keys(raw.message || {}), message: raw.message });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DIAGNÓSTICO: intenta enviar a un JID y devuelve éxito o el error EXACTO de WhatsApp.
// Si no se pasa jid, usa el de la conversación activa más reciente.
router.post('/diag-envio', auth, async (req, res) => {
    try {
        const { getClient } = require('../services/whatsappClient');
        const sock = getClient();
        if (!sock) return res.json({ ok: false, motivo: 'sock_null', detalle: 'WhatsApp no inicializado' });

        let jid = req.body && req.body.jid;
        let fuente = 'body';
        if (!jid) {
            const conv = await Conversacion.findOne({
                where: { estado: { [Op.in]: ['nuevo','viendo_producto','menu','esperando_email','esperando_comprobante'] } },
                order: [['updatedAt', 'DESC']]
            });
            jid = conv && conv.numero_wa;
            fuente = 'ultima_conversacion';
        }
        if (!jid) return res.json({ ok: false, motivo: 'sin_jid' });

        const texto = req.body && req.body.texto ? req.body.texto
            : '🔧 Prueba de conexión. Si recibes esto, el bot ya quedó funcionando ✅';
        try {
            const r = await sock.sendMessage(jid, { text: texto });
            return res.json({ ok: true, enviado: true, jid, fuente, msgId: r?.key?.id || null });
        } catch (e) {
            return res.json({ ok: false, enviado: false, jid, fuente, error: e.message,
                stack: (e.stack || '').split('\n').slice(0,4).join(' | ') });
        }
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
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

                const precio = conv.producto?.precio ? `$${parseInt(conv.producto.precio).toLocaleString('es-CO')}` : '';
                let msg = null;

                if (estado === 'esperando_comprobante') {
                    // Ya dieron correo y conocen el precio → empujar al pago con valor + urgencia + cierre
                    if (esN8n) {
                        msg = `Hola ${nombre} 👋 Te dejé apartado el acceso al pack de n8n — 350 agentes listos para automatizar tu negocio${precio ? ` por ${precio}` : ''}, pago único de por vida. Apenas hagas la transferencia me mandas la captura y en segundos lo tienes todo. ¿Lo dejamos hecho hoy? 🚀`;
                    } else if (esEmula) {
                        msg = `Hola ${nombre} 👋 Te tengo listo el acceso a los +16.000 juegos${precio ? ` por ${precio}` : ''} — pago único, sin mensualidades. Haces la transferencia, me mandas la captura y esta misma tarde estás jugando. ¿Le damos hoy? 🎮`;
                    } else if (esCapcut) {
                        msg = `Hola ${nombre} 👋 Te dejé apartado el curso de CapCut PRO${precio ? ` por ${precio}` : ''} — de por vida, sin mensualidades. Apenas pagues me mandas la captura y arrancas hoy mismo. ¿Lo cerramos? 🎬`;
                    } else {
                        msg = `Hola ${nombre} 👋 Te tengo apartado tu acceso${precio ? ` por ${precio}` : ''}, pago único de por vida. Haces la transferencia, me mandas la captura y en segundos lo tienes. ¿Le damos hoy? 🚀`;
                    }

                } else if (estado === 'esperando_email') {
                    // Falta el correo → pedirlo con cierre asumido + recordar valor
                    if (esN8n) {
                        msg = `Hola ${nombre} 👋 Quedamos en uno y faltó lo último: pásame tu correo y te dejo listo el acceso a los 350 agentes de n8n${precio ? ` (${precio}, de por vida)` : ''}. Cientos ya están automatizando con esto. ¿Cuál es tu correo? ✅`;
                    } else if (esEmula) {
                        msg = `Hola ${nombre} 👋 Solo falta tu correo para dejarte listos los +16.000 juegos${precio ? ` (${precio}, una sola vez)` : ''}. Me lo pasas y arrancamos hoy mismo 🎮 ¿Cuál es?`;
                    } else if (esCapcut) {
                        msg = `Hola ${nombre} 👋 Solo falta tu correo para activarte el curso de CapCut PRO${precio ? ` (${precio}, de por vida)` : ''}. Me lo pasas y te lo dejo listo de una ✅ ¿Cuál es?`;
                    } else {
                        msg = `Hola ${nombre} 👋 Solo falta tu correo para dejarte todo listo${precio ? ` (${precio}, pago único de por vida)` : ''}. ¿Cuál es? ✅`;
                    }

                } else if (['viendo_producto','menu'].includes(estado) && prod) {
                    // Vio el producto pero no avanzó → re-enganche con valor + prueba social + cierre suave
                    if (esN8n) {
                        msg = `Hola ${nombre} 👋 Quedé pendiente de ti con el pack de n8n. 350 agentes para automatizar tu negocio${precio ? ` por ${precio}` : ''}, pago único — la mayoría arranca el mismo día. ¿Te dejo el acceso listo? 🤖`;
                    } else if (esCapcut) {
                        msg = `Hola ${nombre} 👋 ¿Le seguimos al curso de CapCut PRO? Aprendes a editar como pro${precio ? ` por ${precio}` : ''}, de por vida. Cientos ya lo están usando. ¿Te lo activo? 🎬`;
                    } else if (esEmula) {
                        msg = `Hola ${nombre} 👋 ¿Le entramos a los +16.000 juegos? PS1, PS2, PS3, Xbox, Nintendo y más${precio ? ` por ${precio}` : ''}, pago único de por vida. ¿Te dejo el acceso listo hoy? 🎮`;
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

// Oferta de recuperación de EmulaConsolas: precio especial $15.000 (lista sigue en $20.000)
// Marca notas.precio_oferta para que el bot cierre a ese precio. Body opcional: { precioOferta: 15000 }
router.post('/broadcast-precio-emula', auth, async (req, res) => {
    const precioOferta = parseInt(req.body?.precioOferta) || 15000;
    res.json({ ok: true, msg: `Oferta emula ($${precioOferta}) iniciando...` });
    setTimeout(async () => {
        try {
            const { Op } = require('sequelize');
            const { enviarTexto } = require('../services/whatsappService');
            const delay = ms => new Promise(r => setTimeout(r, ms));

            const emula = await Producto.findOne({ where: { nombre: { [Op.like]: '%mula%' } } });
            if (!emula) { console.log('[oferta-emula] Producto no encontrado'); return; }

            // Solo leads de emuladora que NO compraron
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
                const msg = `Hola ${nombre} 👋 Te tengo una oferta especial solo por hoy: el pack de +16.000 juegos (PS1, PS2, PS3, Xbox, Nintendo y más) te lo dejo en *${fmt(precioOferta)}* de por vida, en vez de ${fmt(emula.precio)} 🎮🔥\n\nPago único, sin mensualidades. ¿Te lo activo hoy? Mándame tu correo y listo ✅`;
                try {
                    await enviarTexto(conv.numero_wa, msg);
                    // Marcar precio de oferta + asegurar producto asignado para que el bot cierre a $15k
                    const nuevasNotas = { ...(conv.notas || {}), precio_oferta: precioOferta, oferta_emula_enviada: Date.now() };
                    const h = [...(conv.historial || []), { rol: 'bot', texto: msg, ts: Date.now() }].slice(-30);
                    const upd = { historial: h, ultimo_mensaje: msg.slice(0, 200), notas: nuevasNotas };
                    if (!conv.producto_id) upd.producto_id = emula.id;
                    await conv.update(upd);
                    enviados++;
                    await delay(3000);
                } catch (e) { console.error('[oferta-emula] Error a', conv.numero_wa, e.message); }
            }
            console.log(`[oferta-emula] ${enviados} ofertas enviadas a $${precioOferta}`);
        } catch (e) { console.error('[oferta-emula] Error general:', e.message); }
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
