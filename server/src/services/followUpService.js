const cron      = require('node-cron');
const { Op }    = require('sequelize');
const Anthropic = require('@anthropic-ai/sdk');
const { Conversacion, Producto } = require('../models');
const { enviarTexto } = require('./whatsappService');
const { notificarTelegram } = require('./botService');

// ── IA para followups personalizados ─────────────────────────────────────────
async function generarFollowupIA(conv, producto, situacion) {
    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const historial = (conv.historial || []).slice(-6)
            .map(h => `${h.rol === 'user' ? 'Cliente' : 'Sofía'}: ${h.texto}`)
            .join('\n');
        const nombreP = producto?.nombre || '';
        const esN8n = /n8n|agente/i.test(nombreP);

        const prompt = `Eres Sofía, asesora de ventas por WhatsApp. Colombiana, cercana.

Producto: ${nombreP || 'producto digital'} — $20.000 pago único de por vida
${esN8n ? 'Pack n8n: 350 agentes de automatización listos para usar en cualquier negocio' : 'Curso CapCut PRO: pack completo con edición de video, reels y Photoshop'}

Conversación previa:
${historial || '(sin historial previo)'}

Situación: ${situacion}

Escribe UN mensaje de WhatsApp de máximo 2 líneas. Natural, sin presión, que re-abra la conversación. No menciones "correo" ni "pago" a menos que la situación lo pida. Personaliza según lo que dijo el cliente. Solo el texto del mensaje, sin comillas.`;

        const resp = await client.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 120,
            messages:   [{ role: 'user', content: prompt }]
        });
        return resp.content[0]?.text?.trim() || null;
    } catch (e) {
        console.error('FollowupIA error:', e.message);
        return null;
    }
}

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

        // Mensaje 1: 2 horas después — simple, sin repetir datos de pago
        if (!notas.seg_pago_1 && ahora - ultima > 2 * HORA) {
            const msgs = [
                `¿Ya pudiste hacer el pago? Mándame la captura cuando puedas y te envío el acceso de una ⚡`,
                `Hola 😊 ¿Todo bien con el pago? Cuando tengas la captura me la mandas y listo ✅`,
                `¿Pudiste hacer la transferencia? Cuando quieras me mandas la captura y en segundos tienes el acceso 🙌`
            ];
            const msg = msgs[Math.floor(Math.random() * msgs.length)];
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
            estado:      ['menu', 'viendo_producto'],
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

        // Followup personalizado con IA según el historial real del cliente
        const ultimoUser = [...(conv.historial || [])].reverse().find(h => h.rol === 'user');
        const contexto = ultimoUser?.texto
            ? `El cliente dijo: "${ultimoUser.texto}". Re-abre la conversación con algo relacionado a eso.`
            : `El cliente vio el producto pero no respondió. Pregunta algo que genere curiosidad.`;

        const msg = await generarFollowupIA(conv, producto, contexto) ||
            `Hola 👋 ¿Quedaste con alguna duda del producto? Aquí estoy 😊`;

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
            estado:      'viendo_producto',
            producto_id: null,
            updatedAt:   { [Op.between]: [hace18h, hace4h] }
        }
    });

    for (const conv of frios) {
        const notas = conv.notas || {};
        if (notas.seg_frio_1) continue;
        const ahora = Date.now();

        const msg = await generarFollowupIA(conv, null,
            `El cliente preguntó sobre productos digitales pero no llegó a ver ninguno en detalle. Re-abre la conversación con una pregunta curiosa sobre qué tipo de negocio o proyecto tiene.`
        ) || `Hola 👋 ¿Te quedó alguna pregunta de lo que hablamos? Aquí estoy 😊`;
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
