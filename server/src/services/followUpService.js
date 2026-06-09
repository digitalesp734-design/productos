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
        const historial = (conv.historial || []).slice(-10)
            .map(h => `${h.rol === 'user' ? 'Cliente' : 'Cristian'}: ${h.texto}`)
            .join('\n');
        const nombreP = producto?.nombre || '';
        const esN8n = /n8n|agente/i.test(nombreP);

        const precio = producto?.precio ? `$${parseInt(producto.precio).toLocaleString('es-CO')}` : '$20.000';
        const esEmula = /emula/i.test(nombreP);
        let contextoProducto = '';
        if (esN8n) contextoProducto = `Pack n8n: 350 agentes de automatización listos para importar. ${precio} de por vida, sin programar.`;
        else if (esEmula) contextoProducto = `EmulaConsolas: +16.000 juegos de 32 consolas (PS1, PS2, PS3, Xbox, Nintendo). ${precio} de por vida. Instala en PC, celu o tablet.`;
        else if (nombreP) contextoProducto = `${nombreP}: ${precio} de por vida.`;

        const prompt = `Eres Cristian, asesor de ventas por WhatsApp de AI Company CO. Colombiano, cercano y directo.

${contextoProducto || `Producto digital — ${precio} pago único de por vida`}

Conversación previa:
${historial || '(sin historial previo)'}

Situación: ${situacion}

Escribe UN mensaje de WhatsApp de máximo 2 líneas. Natural, sin presión. Personaliza según lo que dijo el cliente. Solo el texto del mensaje, sin comillas ni explicaciones.`;

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

// Colombia = UTC-5. Solo enviar mensajes entre 8 AM y 10 PM hora Colombia
function esHorarioHabil() {
    const horaUTC = new Date().getUTCHours();
    const horaCol = (horaUTC - 5 + 24) % 24;
    return horaCol >= 8 && horaCol < 22;
}

// Detectar si el cliente prometió pagar pronto en los últimos mensajes
function prometioPagarPronto(historial) {
    const msgs = (historial || []).slice(-6);
    return msgs.some(h => h.rol === 'user' &&
        /dale|listo|ok|perfecto|me lo llevo|lo quiero|voy a pagar|te pago|ahorita|en la tarde|en un rato|mañana pago|ahora pago|lo voy a comprar|me animo|si quiero/i.test(h.texto || '')
    );
}

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

// ── 3. Vio el producto pero no siguió — 3 etapas de seguimiento ──────────────
async function seguimientoInteres() {
    const pendientes = await Conversacion.findAll({
        where: {
            estado:      ['menu', 'viendo_producto'],
            producto_id: { [Op.not]: null },
            updatedAt:   { [Op.lt]: new Date(Date.now() - 3 * HORA) }
        }
    });

    for (const conv of pendientes) {
        const notas   = conv.notas || {};
        const ahora   = Date.now();
        const ultima  = new Date(conv.updatedAt).getTime();
        const producto = await Producto.findByPk(conv.producto_id);
        if (!producto) continue;

        const precio = `$${parseInt(producto.precio).toLocaleString('es-CO')}`;
        const ultimoUser = [...(conv.historial || [])].reverse().find(h => h.rol === 'user');

        // Etapa 1: 3h después — IA personalizada, re-abre conversación
        if (!notas.seg_interes_1 && ahora - ultima >= 3 * HORA && ahora - ultima < 48 * HORA) {
            const contexto = ultimoUser?.texto
                ? `El cliente dijo: "${ultimoUser.texto}". Re-abre con algo relacionado a eso.`
                : `El cliente vio el producto pero no respondió. Pregunta algo que genere curiosidad.`;
            const msg = await generarFollowupIA(conv, producto, contexto) ||
                `Hola 👋 ¿Quedaste con alguna duda del ${producto.nombre}? Aquí estoy 😊`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_interes_1: ahora } });
            await new Promise(r => setTimeout(r, 1500));
            continue;
        }

        // Etapa 2: 12h después — IA personalizada con historial + precio
        if (!notas.seg_interes_2 && notas.seg_interes_1 && ahora - notas.seg_interes_1 >= 9 * HORA) {
            const esN8n = /n8n|agente/i.test(producto.nombre);
            const esEmula = /emula/i.test(producto.nombre);
            const ultimoBot = [...(conv.historial || [])].reverse().find(h => h.rol === 'bot');
            let contexto;
            if (esN8n) {
                contexto = `El cliente vio el pack de n8n (${precio} de por vida). Último mensaje del bot: "${ultimoBot?.texto || ''}". Envía un mensaje recordando que son automatizaciones listas para usar, sin programar, y menciona el precio. Pregunta cuánto tiempo le toma el proceso que quiere automatizar.`;
            } else if (esEmula) {
                contexto = `El cliente vio EmulaConsolas (${precio} de por vida, +16.000 juegos). Último mensaje del bot: "${ultimoBot?.texto || ''}". Recuérdale el catálogo de juegos y pregunta si tiene PC, celu o tablet para darle más info.`;
            } else {
                contexto = `El cliente vio el pack CapCut (${precio} de por vida). Último mensaje del bot: "${ultimoBot?.texto || ''}". Recuérdale que son ${precio} de por vida, sin mensualidades. Pregunta cuál es su duda principal o para qué plataforma edita (TikTok/Instagram/YouTube).`;
            }
            const msg = await generarFollowupIA(conv, producto, contexto) ||
                (esN8n ? `Oye, ¿cuántas horas semanales te toma el proceso que quieres automatizar? El pack son ${precio} de por vida 💡` :
                 esEmula ? `¿Tienes PC, celular o tablet? Así te digo cómo instalarlo. Son ${precio} únicos, sin más pagos 🎮` :
                 `¿Cuál es tu duda principal del pack CapCut? Son ${precio} de por vida — sin mensualidades 🎬`);
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_interes_2: ahora } });
            await new Promise(r => setTimeout(r, 1500));
            continue;
        }

        // Etapa 3: 24h después — cierre suave, último intento
        if (!notas.seg_interes_3 && notas.seg_interes_2 && ahora - notas.seg_interes_2 >= 12 * HORA) {
            const msg = `Hola 👋 Te escribo por última vez. Si en algún momento quieres el acceso son solo ${precio} de por vida — me mandas tu correo y te lo envío en segundos. Sin afán 😊`;
            await enviarTexto(conv.numero_wa, msg);
            await guardarHistorial(conv, 'bot', msg);
            await conv.update({ notas: { ...notas, seg_interes_3: ahora } });
            await new Promise(r => setTimeout(r, 1500));
        }
    }
}

// ── 4. Prometió pagar pero no mandó comprobante ──────────────────────────────
async function seguimientoPago() {
    const pendientes = await Conversacion.findAll({
        where: { estado: { [Op.in]: ['viendo_producto', 'esperando_email', 'esperando_comprobante', 'menu'] } }
    });

    for (const conv of pendientes) {
        const notas = conv.notas || {};
        const ahora = Date.now();
        const ultima = new Date(conv.updatedAt).getTime();

        // Solo si prometió pagar hace entre 1h y 24h, y no le hemos recordado
        if (notas.seg_pago_recordatorio) continue;
        if (ahora - ultima < 1 * HORA || ahora - ultima > 24 * HORA) continue;
        if (!prometioPagarPronto(conv.historial)) continue;

        const producto = conv.producto_id ? await Producto.findByPk(conv.producto_id) : null;
        const precio = producto ? `$${parseInt(producto.precio).toLocaleString('es-CO')}` : '$20.000';

        const msg = await generarFollowupIA(conv, producto,
            `El cliente dijo que iba a pagar pero no ha enviado el comprobante. Recuérdale de forma natural y cordial que puede hacer el pago cuando quiera. Menciona el precio (${precio}) y que el acceso llega en segundos tras el comprobante.`
        ) || `Hola 👋 ¿Pudiste hacer el pago? Cuando tengas la captura me la mandas y en segundos tienes el acceso ⚡`;

        await enviarTexto(conv.numero_wa, msg);
        await guardarHistorial(conv, 'bot', msg);
        await conv.update({ notas: { ...notas, seg_pago_recordatorio: ahora } });
        await new Promise(r => setTimeout(r, 1500));
    }
}

// ── 5. Conversación fría — re-abrir natural ──────────────────────────────────
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
    if (!esHorarioHabil()) {
        console.log('[FollowUp] Fuera de horario (8am-10pm Colombia) — omitiendo');
        return;
    }
    console.log('[FollowUp] Revisando...');
    try { await seguimientoPago();        } catch (e) { console.error('[FollowUp] pago:', e.message); }
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
