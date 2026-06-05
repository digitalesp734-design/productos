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
        // Mensaje 2: 4 horas — maneja objeción precio
        else if (!notas.seg_pago_2 && notas.seg_pago_1 && ahora - notas.seg_pago_1 > 3 * HORA) {
            const msg = `Hola de nuevo 😊 ¿Tuviste algún inconveniente con el pago?\n\nSi el precio es el tema, recuerda que son *${precio} una sola vez de por vida* — ya no pagas más nada.\n\n¿Lo pedimos hoy? 🙌`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_pago_2: ahora } });
        }
        // Mensaje 3: 12 horas — último intento
        else if (!notas.seg_pago_3 && notas.seg_pago_2 && ahora - notas.seg_pago_2 > 8 * HORA) {
            const msg = `Última vez que te escribo 😊\n\n¿Qué pasó con *${nombreP}*? Si algo no está claro o tuviste algún problema, cuéntame.\n\nSi ya no te interesa, no hay problema — sin compromisos 🙌`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_pago_3: ahora } });
        }
    }
}

// ── 2. Email pendiente ────────────────────────────────────────────────────────
async function seguimientoEmail() {
    const pendientes = await Conversacion.findAll({ where: { estado: 'esperando_email' } });

    for (const conv of pendientes) {
        const notas  = conv.notas || {};
        const ultima = new Date(conv.updatedAt).getTime();
        const ahora  = Date.now();

        if (!notas.seg_email_1 && ahora - ultima > 45 * MIN) {
            const msg = `Hola 👋 Solo falta tu correo para enviarte el acceso.\n\n¿Cuál es tu email? 📧`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_email_1: ahora } });
        }
        else if (!notas.seg_email_2 && notas.seg_email_1 && ahora - notas.seg_email_1 > 3 * HORA) {
            const msg = `Oye 😊 ¿Me das tu correo? Es el último paso para que tengas el acceso.\n\nEscríbelo aquí y ya queda listo ✅`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_email_2: ahora } });
        }
    }
}

// ── 3. Vio el producto pero no siguió ─────────────────────────────────────────
async function seguimientoInteres() {
    const pendientes = await Conversacion.findAll({
        where: {
            estado:     ['menu', 'activo'],
            producto_id: { [Op.not]: null },
            updatedAt:  { [Op.lt]: new Date(Date.now() - 2 * HORA) }
        }
    });

    for (const conv of pendientes) {
        const notas   = conv.notas || {};
        const ahora   = Date.now();
        const ultima  = new Date(conv.updatedAt).getTime();
        if (notas.seg_interes_1 || ahora - ultima > 24 * HORA) continue;

        const producto = await Producto.findByPk(conv.producto_id);
        if (!producto) continue;

        const esN8n = /n8n|agente/i.test(producto.nombre);
        const msg = esN8n
            ? `Hola 👋 ¿Qué te pareció el Pack de n8n?\n\nTenemos clientes en toda Colombia usando los agentes para automatizar ventas, atención al cliente y más.\n\n¿Qué te detiene para tenerlo hoy? 🔥`
            : `Hola 👋 ¿Qué dudas tienes sobre *${producto.nombre}*?\n\nEstoy aquí para ayudarte — ¿lo pedimos? 😊`;

        await enviarTexto(conv.numero_wa, msg);
        await guardarHistorial(conv, 'bot', msg);
        await conv.update({ notas: { ...notas, seg_interes_1: ahora } });
    }
}

// ── 4. Conversación fría (chateo pero no llegó a producto) ───────────────────
async function seguimientoFrio() {
    const hace3h  = new Date(Date.now() - 3  * HORA);
    const hace12h = new Date(Date.now() - 12 * HORA);

    const frios = await Conversacion.findAll({
        where: {
            estado:     'activo',
            producto_id: null,
            updatedAt:  { [Op.between]: [hace12h, hace3h] }
        }
    });

    for (const conv of frios) {
        const notas = conv.notas || {};
        if (notas.seg_frio_1) continue;
        const ahora = Date.now();

        const msg = `Hola 👋 ¿Te quedó alguna duda de lo que hablamos?\n\nTengo dos cosas que vuelan ahora mismo:\n🔥 *Curso Capcut* — $20.000\n🤖 *Pack n8n 350 agentes* — $20.000\n\n¿Cuál te interesa más? 😊`;
        await enviarTexto(conv.numero_wa, msg);
        await guardarHistorial(conv, 'bot', msg);
        await conv.update({ notas: { ...notas, seg_frio_1: ahora } });
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
