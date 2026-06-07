const cron   = require('node-cron');
const { Op } = require('sequelize');
const { Conversacion, Producto } = require('../models');
const { enviarTexto } = require('./whatsappService');
const { notificarTelegram } = require('./botService');

const MIN  = 60 * 1000;
const HORA = 60 * MIN;

async function guardarHistorial(conv, rol, texto) {
    const historial = [...(conv.historial || []), { rol, texto, ts: Date.now() }].slice(-30);
    await conv.update({ historial, ultimo_mensaje: texto.slice(0, 200) });
}

function datosPago() {
    const nequi     = process.env.NEQUI_NUMERO     || '';
    const daviplata = process.env.DAVIPLATA_NUMERO  || '';
    const llave     = process.env.LLAVE_NUMERO      || '';
    const nombre    = process.env.PAGO_NOMBRE       || '';
    let txt = '';
    if (nequi)     txt += `📱 Nequi: *${nequi}*\n`;
    if (daviplata) txt += `📱 Daviplata: *${daviplata}*\n`;
    if (llave)     txt += `🔑 Bre-b: *${llave}*\n`;
    if (nombre)    txt += `👤 ${nombre}`;
    return txt.trim();
}

// ── 1. Comprobante pendiente ──────────────────────────────────────────────────
// Mensajes 1h, 4h y 12h — progresivamente más directos
async function seguimientoComprobante() {
    const pendientes = await Conversacion.findAll({ where: { estado: 'esperando_comprobante' } });

    for (const conv of pendientes) {
        const notas     = conv.notas || {};
        const ultima    = new Date(conv.updatedAt).getTime();
        const ahora     = Date.now();
        const producto  = conv.producto_id ? await Producto.findByPk(conv.producto_id) : null;
        const nombreP   = producto?.nombre || 'el producto';
        const precio    = producto?.precio ? `$${parseInt(producto.precio).toLocaleString('es-CO')}` : '';

        // Mensaje 1: 1 hora después
        if (!notas.seg_pago_1 && ahora - ultima > 1 * HORA) {
            const msg = `Hola 👋 ¿Pudiste hacer el pago de *${nombreP}*?\n\n${datosPago()}\n\nMándame la captura y en segundos tienes el acceso ⚡`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_pago_1: ahora } });
        }
        // Mensaje 2: 4 horas — resuelve posibles dudas de pago
        else if (!notas.seg_pago_2 && notas.seg_pago_1 && ahora - notas.seg_pago_1 > 3 * HORA) {
            const msg = `Hola 😊 ¿Todo bien con el pago? Si tuviste algún problema con la plataforma o necesitas otro método, cuéntame y lo resolvemos.\n\nRecuerda que son *${precio} una sola vez* — sin mensualidades ni nada más 🙌`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_pago_2: ahora } });
        }
        // Mensaje 3: 12 horas — cierre sin presión
        else if (!notas.seg_pago_3 && notas.seg_pago_2 && ahora - notas.seg_pago_2 > 8 * HORA) {
            const msg = `Hola 👋 Te escribo por última vez por si se te pasó.\n\nSi ya no te interesa está bien, sin problema. Y si quieres retomarlo cuando puedas, aquí estoy 😊`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_pago_3: ahora } });
        }
    }
}

// ── 2. Expresó intención de compra pero no dio correo ────────────────────────
async function seguimientoEmail() {
    const pendientes = await Conversacion.findAll({ where: { estado: 'esperando_email' } });

    for (const conv of pendientes) {
        const notas  = conv.notas || {};
        const ultima = new Date(conv.updatedAt).getTime();
        const ahora  = Date.now();

        // 1h después: recordatorio suave
        if (!notas.seg_email_1 && ahora - ultima > 1 * HORA) {
            const msgs = [
                `Cuando puedas me mandas tu correo y te envío el acceso de una 😊`,
                `Oye, cuando tengas un momento me escribes tu correo y ya queda listo 📧`,
                `¿Sigues por aquí? Solo necesito tu correo para enviarte todo ✅`
            ];
            const msg = msgs[Math.floor(Math.random() * msgs.length)];
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_email_1: ahora } });
        }
        // 5h después: último intento, sin presión
        else if (!notas.seg_email_2 && notas.seg_email_1 && ahora - notas.seg_email_1 > 4 * HORA) {
            const msg = `Hola 😊 por si acaso te quedó pendiente — cuando quieras me mandas el correo y te envío el acceso. Sin afán 🙌`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_email_2: ahora } });
        }
    }
}

// ── 3. Vio el producto pero no siguió — re-enganchar, NO presionar ────────────
async function seguimientoInteres() {
    const pendientes = await Conversacion.findAll({
        where: {
            estado:      ['menu', 'activo'],
            producto_id: { [Op.not]: null },
            updatedAt:   { [Op.lt]: new Date(Date.now() - 3 * HORA) }
        }
    });

    for (const conv of pendientes) {
        const notas  = conv.notas || {};
        const ahora  = Date.now();
        const ultima = new Date(conv.updatedAt).getTime();
        if (notas.seg_interes_1 || ahora - ultima > 24 * HORA) continue;

        const producto = await Producto.findByPk(conv.producto_id);
        if (!producto) continue;

        const esN8n = /n8n|agente/i.test(producto.nombre);

        // Preguntas que abren conversación, no cierran venta
        const msgsN8n = [
            `Hola 👋 ¿Le diste ojo al pack de n8n? Si tienes alguna duda de cómo funciona, aquí estoy 😊`,
            `Oye, ¿hay algo del pack de n8n que no quedó claro? Cuéntame y te explico 🤖`,
            `¿Para qué proceso lo estabas pensando usar? Así te digo cuál agente te sirve más 💡`
        ];
        const msgsCapcut = [
            `Hola 👋 ¿Le diste ojo al curso de CapCut? Si tienes alguna duda cuéntame 😊`,
            `Oye, ¿qué tipo de contenido estás pensando hacer? Así te digo qué parte del curso te sirve más 🎬`,
            `¿Tienes alguna duda del curso? Aquí estoy para lo que necesites 🙌`
        ];

        const opciones = esN8n ? msgsN8n : msgsCapcut;
        const msg = opciones[Math.floor(Math.random() * opciones.length)];

        await enviarTexto(conv.numero_wa, msg);
        await guardarHistorial(conv, 'bot', msg);
        await conv.update({ notas: { ...notas, seg_interes_1: ahora } });

        await new Promise(r => setTimeout(r, 1200));
    }
}

// ── 4. Conversación fría — re-abrir natural ──────────────────────────────────
async function seguimientoFrio() {
    const hace4h  = new Date(Date.now() - 4  * HORA);
    const hace18h = new Date(Date.now() - 18 * HORA);

    const frios = await Conversacion.findAll({
        where: {
            estado:      'activo',
            producto_id: null,
            updatedAt:   { [Op.between]: [hace18h, hace4h] }
        }
    });

    for (const conv of frios) {
        const notas = conv.notas || {};
        if (notas.seg_frio_1) continue;
        const ahora = Date.now();

        const msgs = [
            `Hola 👋 ¿Te quedó alguna pregunta de lo que hablamos? Aquí estoy 😊`,
            `Oye, ¿pudiste revisar la info? Si necesitas algo más cuéntame 🙌`,
            `¿Hay algo en lo que te pueda ayudar? Por aquí estoy cuando quieras 😊`
        ];
        const msg = msgs[Math.floor(Math.random() * msgs.length)];
        await enviarTexto(conv.numero_wa, msg);
        await guardarHistorial(conv, 'bot', msg);
        await conv.update({ notas: { ...notas, seg_frio_1: ahora } });

        await new Promise(r => setTimeout(r, 1200));
    }
}

// ── 5. Upsell 24h después de compra ──────────────────────────────────────────
async function seguimientoUpsell() {
    const hace24h = new Date(Date.now() - 24 * HORA);
    const hace72h = new Date(Date.now() - 72 * HORA);

    const comprados = await Conversacion.findAll({
        where: {
            estado:    'completado',
            updatedAt: { [Op.between]: [hace72h, hace24h] }
        }
    });

    for (const conv of comprados) {
        const notas = conv.notas || {};
        if (notas.upsell_enviado) continue;

        const { enviarUpsell } = require('./botService');
        await enviarUpsell(conv);
        await conv.update({ notas: { ...notas, upsell_enviado: Date.now() } });
    }
}

// ── Ejecutar todo ─────────────────────────────────────────────────────────────
async function ejecutarSeguimientos() {
    console.log('[FollowUp] Revisando...');
    try { await seguimientoComprobante(); } catch (e) { console.error('[FollowUp] comprobante:', e.message); }
    try { await seguimientoEmail();       } catch (e) { console.error('[FollowUp] email:', e.message); }
    try { await seguimientoInteres();     } catch (e) { console.error('[FollowUp] interes:', e.message); }
    try { await seguimientoFrio();        } catch (e) { console.error('[FollowUp] frio:', e.message); }
    try { await seguimientoUpsell();      } catch (e) { console.error('[FollowUp] upsell:', e.message); }
}

function iniciarFollowUpService() {
    cron.schedule('*/20 * * * *', ejecutarSeguimientos);
    console.log('✅ Follow-up activo (cada 20 min)');
}

module.exports = { iniciarFollowUpService, ejecutarSeguimientos };
