const cron   = require('node-cron');
const { Op } = require('sequelize');
const { Conversacion, Producto } = require('../models');
const { enviarTexto } = require('./whatsappService');
const { notificarTelegram } = require('./botService');

const HORA_MS = 60 * 60 * 1000;

async function guardarHistorial(conv, rol, texto) {
    const historial = [...(conv.historial || []), { rol, texto, ts: Date.now() }].slice(-30);
    await conv.update({ historial, ultimo_mensaje: texto.slice(0, 200) });
}

// ── Seguimiento 1: comprobante pendiente > 2h ──────────────────────────────────
async function seguimientoComprobante() {
    const hace2h = new Date(Date.now() - 2 * HORA_MS);
    const hace6h = new Date(Date.now() - 6 * HORA_MS);

    const pendientes = await Conversacion.findAll({
        where: {
            estado: 'esperando_comprobante',
            updatedAt: { [Op.lt]: hace2h }
        }
    });

    for (const conv of pendientes) {
        const notas    = conv.notas || {};
        const yaEnvio1 = notas.seguimiento_pago_1;
        const yaEnvio2 = notas.seguimiento_pago_2;

        if (!yaEnvio1) {
            const producto = conv.producto_id ? await Producto.findByPk(conv.producto_id) : null;
            const nombreP  = producto?.nombre || 'tu producto';
            const msg = `¡Hola! 👋 ¿Pudiste hacer el pago de *${nombreP}*?\n\nAquí te recuerdo los datos:\n${datosNequi()}\n\n📸 Solo envíame el comprobante y en segundos tienes el acceso ⚡`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seguimiento_pago_1: Date.now() } });
            console.log(`📲 Seguimiento pago 1 → ${conv.numero_wa}`);

        } else if (!yaEnvio2 && conv.updatedAt < hace6h) {
            const producto = conv.producto_id ? await Producto.findByPk(conv.producto_id) : null;
            const nombreP  = producto?.nombre || 'tu producto';
            const msg = `Hola de nuevo 😊 Noto que aún no has enviado el comprobante de *${nombreP}*.\n\n¿Tuviste algún problema con el pago? Cuéntame y lo resolvemos. Acepto *Nequi, Daviplata, transferencia* — lo que te quede más fácil.\n\n${datosNequi()}`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seguimiento_pago_2: Date.now() } });
            console.log(`📲 Seguimiento pago 2 → ${conv.numero_wa}`);
        }
    }
}

// ── Seguimiento 2: pidió email pero no lo dio > 2h ────────────────────────────
async function seguimientoEmail() {
    const hace2h = new Date(Date.now() - 2 * HORA_MS);

    const pendientes = await Conversacion.findAll({
        where: {
            estado: 'esperando_email',
            updatedAt: { [Op.lt]: hace2h }
        }
    });

    for (const conv of pendientes) {
        const notas = conv.notas || {};
        if (notas.seguimiento_email) continue;

        const msg = `¡Hola! 👋 Solo falta tu correo electrónico para enviarte el acceso.\n\n¿Cuál es tu email? 📧`;
        await enviarTexto(conv.numero_wa, msg);
        await guardarHistorial(conv, 'bot', msg);
        await conv.update({ notas: { ...notas, seguimiento_email: Date.now() } });
        console.log(`📲 Seguimiento email → ${conv.numero_wa}`);
    }
}

// ── Seguimiento 3: vio el menú pero no compró > 4h ────────────────────────────
async function seguimientoMenu() {
    const hace4h  = new Date(Date.now() - 4  * HORA_MS);
    const hace24h = new Date(Date.now() - 24 * HORA_MS);

    const pendientes = await Conversacion.findAll({
        where: {
            estado: ['menu', 'viendo_producto'],
            updatedAt: { [Op.between]: [hace24h, hace4h] }
        }
    });

    for (const conv of pendientes) {
        const notas = conv.notas || {};
        if (notas.seguimiento_menu) continue;

        const msg = `¡Hola! 👋 Sigo por aquí si tienes alguna duda sobre los productos.\n\n¿En qué te puedo ayudar? 😊`;
        await enviarTexto(conv.numero_wa, msg);
        await guardarHistorial(conv, 'bot', msg);
        await conv.update({ notas: { ...notas, seguimiento_menu: Date.now() } });
        console.log(`📲 Seguimiento menú → ${conv.numero_wa}`);
    }
}

// ── Seguimiento 4: upsell 24h después de compra ───────────────────────────────
async function seguimientoUpsell() {
    const hace24h = new Date(Date.now() - 24 * HORA_MS);
    const hace72h = new Date(Date.now() - 72 * HORA_MS);

    const comprados = await Conversacion.findAll({
        where: {
            estado: 'completado',
            updatedAt: { [Op.between]: [hace72h, hace24h] }
        }
    });

    for (const conv of comprados) {
        const notas = conv.notas || {};
        if (notas.upsell_enviado) continue;

        // Importar dinámico para evitar dependencia circular
        const { enviarUpsell } = require('./botService');
        await enviarUpsell(conv);
        console.log(`🎯 Upsell → ${conv.numero_wa}`);
    }
}

// ── Helper datos de pago ──────────────────────────────────────────────────────
function datosNequi() {
    const nequi  = process.env.NEQUI_NUMERO  || '';
    const llaves = process.env.LLAVES_EMAIL  || '';
    let txt = '';
    if (nequi)  txt += `📱 *Nequi:* ${nequi}\n`;
    if (llaves) txt += `🔑 *Llaves:* ${llaves}`;
    return txt;
}

// ── Ejecutar todos los seguimientos ──────────────────────────────────────────
async function ejecutarSeguimientos() {
    console.log('[FollowUp] Verificando seguimientos pendientes...');
    try { await seguimientoComprobante(); } catch (e) { console.error('[FollowUp] comprobante:', e.message); }
    try { await seguimientoEmail();       } catch (e) { console.error('[FollowUp] email:', e.message); }
    try { await seguimientoMenu();        } catch (e) { console.error('[FollowUp] menu:', e.message); }
    try { await seguimientoUpsell();      } catch (e) { console.error('[FollowUp] upsell:', e.message); }
}

// ── Iniciar scheduler cada 30 minutos ────────────────────────────────────────
function iniciarFollowUpService() {
    cron.schedule('*/30 * * * *', ejecutarSeguimientos);
    console.log('✅ Follow-up automático activo (cada 30 min)');
}

module.exports = { iniciarFollowUpService, ejecutarSeguimientos };
