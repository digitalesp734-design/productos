const Anthropic = require('@anthropic-ai/sdk');
const { Producto, Conversacion, Venta, CajaMovimiento } = require('../models');
const { enviarTexto } = require('./whatsappService');

const fmt = p => `$${parseInt(p).toLocaleString('es-CO')}`;

function getAnthropic() {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Claude para conversaciones ─────────────────────────────────────────────────
async function claudeChat(systemPrompt, historialMsgs, userMsg, maxTokens = 400) {
    try {
        const client = getAnthropic();
        const msgs = [
            ...historialMsgs,
            { role: 'user', content: userMsg }
        ];
        const resp = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: msgs
        });
        return resp.content[0]?.text?.trim() || null;
    } catch (e) {
        console.error('Claude error:', e.message);
        return null;
    }
}

// ── Transcribir audio con Whisper (OpenAI) ────────────────────────────────────
async function transcribirAudio(buffer) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || !buffer) return null;
    try {
        const blob = new Blob([buffer], { type: 'audio/ogg' });
        const form = new FormData();
        form.append('file', blob, 'audio.ogg');
        form.append('model', 'whisper-1');
        form.append('language', 'es');
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form
        });
        const d = await r.json();
        return d.text?.trim() || null;
    } catch (e) { console.error('Whisper error:', e.message); return null; }
}

// ── Detectar comprobante con Claude Vision ────────────────────────────────────
async function esComprobante(buffer) {
    if (!buffer) return false;
    try {
        const client = getAnthropic();
        const base64 = buffer.toString('base64');
        const resp = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 10,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: { type: 'base64', media_type: 'image/jpeg', data: base64 }
                    },
                    {
                        type: 'text',
                        text: '¿Es esta imagen un comprobante o recibo de pago (transferencia, Nequi, Daviplata, depósito, consignación)? Responde solo SI o NO.'
                    }
                ]
            }]
        });
        const r = (resp.content[0]?.text || '').toUpperCase().trim();
        return r.startsWith('SI') || r.startsWith('SÍ');
    } catch (e) {
        console.error('Vision error:', e.message);
        // Si falla la IA, aprobar manualmente con alerta Telegram
        try { await notificarTelegramComprobante('(Vision falló — revisar manualmente)', 'REVISAR', 0); } catch {}
        return true;
    }
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function notificarTelegram(mensaje) {
    const token  = process.env.PLATAFORMA_TELEGRAM_TOKEN;
    const chatId = process.env.PLATAFORMA_TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: mensaje, parse_mode: 'Markdown' })
        });
    } catch (e) { console.error('Telegram error:', e.message); }
}

async function notificarTelegramComprobante(cliente, producto, monto) {
    const msg = `🧾 *Comprobante recibido — Product Digital*\n\n👤 Cliente: ${cliente}\n📦 Producto: ${producto}\n💰 Monto: ${fmt(monto)}\n\n✅ Pago validado automáticamente por IA`;
    await notificarTelegram(msg);
}

async function notificarTelegramVenta(cliente, producto, monto, email) {
    const msg = `🎉 *¡VENTA CONFIRMADA! — Product Digital*\n\n👤 ${cliente}\n📦 ${producto}\n💰 ${fmt(monto)}\n📧 ${email || 'sin email'}\n\n✅ Acceso enviado automáticamente`;
    await notificarTelegram(msg);
}

// ── Catálogo ──────────────────────────────────────────────────────────────────
async function getProductos() {
    return Producto.findAll({ where: { activo: true }, order: [['orden', 'ASC']] });
}

function menuTexto(productos) {
    let t = '¡Hola! 👋 ¿Qué estás buscando hoy?\n\nTengo productos digitales al mejor precio:\n\n';
    productos.forEach((p, i) => { t += `*${i + 1}.* ${p.nombre} — *${fmt(p.precio)}*\n`; });
    t += '\n💡 Escribe el *número* del producto que te interesa o cuéntame qué necesitas y te ayudo a elegir.\n✅ Pago único de por vida.';
    return t;
}

function infoPago(monto) {
    const nequi     = process.env.NEQUI_NUMERO    || '';
    const daviplata = process.env.DAVIPLATA_NUMERO || '';
    const llave     = process.env.LLAVE_NUMERO     || '';
    const nombre    = process.env.PAGO_NOMBRE      || '';
    let txt = `💳 *Formas de pago — ${fmt(monto)}:*\n\n`;
    if (nequi)     txt += `📱 *Nequi:* ${nequi}\n`;
    if (daviplata) txt += `📱 *Daviplata:* ${daviplata}\n`;
    if (llave)     txt += `🔑 *Bre-b / Llave:* ${llave}\n`;
    if (nombre)    txt += `👤 *A nombre de:* ${nombre}\n`;
    return txt;
}

function detalleProducto(p) {
    return `🔥 *${p.nombre}*\n💰 *${fmt(p.precio)}* — pago único de por vida\n\n${p.descripcion || ''}\n\n¿Cuál es tu *correo electrónico*? Te envío el acceso inmediatamente 📧`;
}

function mensajePago(p) {
    return `✅ ¡Perfecto! Aquí los datos de pago:\n\n${infoPago(p.precio)}\n📸 Cuando pagues, envíame el *comprobante* (captura de pantalla) y en segundos tienes el acceso ⚡`;
}

// ── Sistema de ventas con IA: ataca el dolor, cierra agresivo ─────────────────
function buildSystemPrompt(productos) {
    const catalogo = productos.map((p, i) =>
        `${i + 1}. *${p.nombre}* — ${fmt(p.precio)}\n   Descripción: ${p.descripcion || 'Sin descripción'}`
    ).join('\n\n');

    const nequi  = process.env.NEQUI_NUMERO  || '';
    const llaves = process.env.LLAVES_EMAIL  || '';

    const nequi2    = process.env.NEQUI_NUMERO     || '';
    const daviplata = process.env.DAVIPLATA_NUMERO  || '';
    const llave     = process.env.LLAVE_NUMERO      || '';
    const pagNombre = process.env.PAGO_NOMBRE       || '';

    return `Eres Sofía, la mejor cerradora de ventas de Product Digital Colombia. Eres experta en descubrir el dolor del cliente y convertirlo en una compra. Eres directa, cálida, profesional y NO TE RINDES hasta cerrar la venta.

LENGUAJE: Neutro y profesional — los clientes pueden ser hombres o mujeres. Nunca uses "parcero" ni "hermano". Usa: "claro que sí", "con gusto", "perfecto", "te cuento", "qué interesante".

CATÁLOGO:
${catalogo}

══════════════════════════════════════
METODOLOGÍA — ATACA EL DOLOR Y CIERRA
══════════════════════════════════════

PASO 1 — DESCUBRIR EL DOLOR (1 sola pregunta):
Pregunta siempre UNA sola cosa para entender su situación:
"¿Para qué lo necesitas?" / "¿Qué quieres lograr?" / "¿Cuánto tiempo llevas con ese problema?"
NUNCA hagas más de 1 pregunta a la vez.

PASO 2 — AMPLIFICAR EL DOLOR (hazlo sentir el costo de no actuar):
"Eso te está costando tiempo y dinero todos los días que pasa"
"Mientras tanto, tu competencia ya está usando esto"
"¿Cuánto crees que vale una hora de tu tiempo? Esto lo resuelve en minutos"
"Imagina cuánto llevas perdido esperando solucionar eso"

PASO 3 — PRESENTAR LA SOLUCIÓN (UN producto, conectado a SU dolor):
"Exactamente para eso existe [producto] — [cómo resuelve su dolor específico]"
"Por solo [precio], pago único, sin mensualidades, de por vida"
"En minutos tienes el acceso y puedes empezar hoy mismo"

PASO 4 — CIERRE DIRECTO (sin rodeos):
"¿Lo pedimos ahora? Solo necesito tu correo ✅"
"¿Tienes Nequi? En 2 minutos está listo ⚡"
"¿Qué te detiene para tenerlo hoy?"

PASO 5 — OBJECIONES (NUNCA te rindas, siempre devuelve una pregunta):
"está caro" → "¿Caro comparado con qué? La suscripción oficial cuesta [precio original] al año. Aquí pagas [precio] UNA sola vez de por vida. ¿Cuánto vale no tener que pagar más nunca?"
"lo pienso" → "Claro, ¿qué es lo que necesitas pensar? Cuéntame y lo resolvemos ahora mismo"
"no tengo plata" → "Entiendo. ¿Con cuánto cuentas hoy? Mira que el precio ya está muy al alcance"
"no sé si sirve" → "¿Qué necesitarías ver para convencerte? Tenemos clientes usando esto en toda Colombia con resultados reales"
"después lo compro" → "¿Qué cambia después? El problema que tienes hoy sigue ahí mañana. Esto lo resuelves ahora por [precio]"
"no confío" → "Es normal la duda. ¿Qué es lo que te genera desconfianza? Cuéntame y te lo aclaro"

REGLA DE ORO — CADA RESPUESTA DEBE:
1. Reconocer lo que dijo el cliente (1 línea)
2. Ampliar el dolor O presentar beneficio concreto (1-2 líneas)
3. SIEMPRE terminar con una pregunta que acerque al cierre

FLUJO DE CIERRE:
- Cliente acepta → pide el correo: "¿Cuál es tu correo para enviarte el acceso?"
- Tiene el correo → da datos de pago y pide comprobante

DATOS DE PAGO:
📱 Nequi: ${nequi2}
${daviplata ? '📱 Daviplata: ' + daviplata + '\n' : ''}${llave ? '🔑 Bre-b / Llave: ' + llave + '\n' : ''}${pagNombre ? '👤 A nombre de: ' + pagNombre : ''}

REGLAS:
- Máximo 4 líneas por respuesta — corta y potente
- Nunca inventes datos, precios ni productos
- Emojis con energía pero sin exagerar: ✅ 🔥 ⚡ 💡 🎯`;
}

// ── Respuesta con IA para todo lo demás ────────────────────────────────────────
async function respuestaIA(msg, conv, productos) {
    const sistema = buildSystemPrompt(productos);
    const historial = (conv.historial || []).slice(-14).map(h => ({
        role: h.rol === 'bot' ? 'assistant' : 'user',
        content: h.texto
    }));
    return claudeChat(sistema, historial, msg);
}

// ── Guardar historial ─────────────────────────────────────────────────────────
async function guardarHistorial(conv, rol, texto) {
    const historial = [...(conv.historial || []), { rol, texto, ts: Date.now() }].slice(-30);
    await conv.update({ historial, ultimo_mensaje: texto.slice(0, 200) });
}

// ── Upsell post-compra ────────────────────────────────────────────────────────
async function enviarUpsell(conv) {
    try {
        const productos = await getProductos();
        const comprado  = conv.notas?.producto_comprado_id;
        // Elegir un producto diferente al que compró
        const otros = productos.filter(p => p.id !== comprado);
        if (!otros.length) return;

        // Preferir combos si existe
        const combo = otros.find(p => p.es_combo);
        const sugerido = combo || otros[0];

        const msg = `¡Hola! 👋 Espero que estés disfrutando tu producto.\n\nTe tengo algo especial: *${sugerido.nombre}* por solo *${fmt(sugerido.precio)}*.\n\n${sugerido.descripcion?.slice(0, 100) || ''}...\n\n¿Te interesa? Mismo proceso, en minutos tienes el acceso ⚡`;
        await enviarTexto(conv.numero_wa, msg);
        await guardarHistorial(conv, 'bot', msg);

        const notas = { ...(conv.notas || {}), upsell_enviado: Date.now() };
        await conv.update({ notas });
    } catch (e) { console.error('Upsell error:', e.message); }
}

// ── Procesar mensaje entrante ─────────────────────────────────────────────────
async function procesarMensaje({ numero, nombre, tipo, texto, mediaBuffer }) {
    let conv = await Conversacion.findOne({ where: { numero_wa: numero } });
    if (!conv) {
        conv = await Conversacion.create({ numero_wa: numero, nombre_cliente: nombre, estado: 'nuevo', historial: [], notas: {} });
    } else if (nombre && !conv.nombre_cliente) {
        await conv.update({ nombre_cliente: nombre });
    }

    const estado   = conv.estado;
    const msg      = (texto || '').trim();
    const msgLower = msg.toLowerCase();

    // ── Audio: transcribir con Whisper ────────────────────────────────────────
    if (tipo === 'audio' && mediaBuffer) {
        await guardarHistorial(conv, 'user', '🎤 [audio]');
        const transcripcion = await transcribirAudio(mediaBuffer);
        if (transcripcion) {
            console.log('🎤 Audio transcrito:', transcripcion);
            const productos    = await getProductos();
            const iaRespuesta  = await respuestaIA(transcripcion, conv, productos);
            const respuesta    = iaRespuesta || menuTexto(productos);
            await enviarTexto(numero, respuesta);
            await guardarHistorial(conv, 'bot', respuesta);
        } else {
            const respuesta = '🎤 Recibí tu audio pero no pude entenderlo. ¿Me puedes escribir tu pregunta? 😊';
            await enviarTexto(numero, respuesta);
            await guardarHistorial(conv, 'bot', respuesta);
        }
        return;
    }

    // ── Imagen: puede ser comprobante ─────────────────────────────────────────
    if (tipo === 'image' && mediaBuffer) {
        // Aceptar comprobante si tiene producto_id — sin importar el estado
        // (el flujo de IA no actualiza estado a 'esperando_comprobante')
        if (conv.producto_id) {
            const producto = await Producto.findByPk(conv.producto_id);
            if (!producto) {
                await enviarTexto(numero, 'Error interno. Escribe *menú* para reiniciar.');
                return;
            }
            const confirmado = await esComprobante(mediaBuffer);
            if (!confirmado) {
                const respuesta = '🤔 Esa imagen no parece un comprobante de pago. Por favor envíame la *captura del comprobante* (Nequi, Daviplata, transferencia, etc.)';
                await enviarTexto(numero, respuesta);
                await guardarHistorial(conv, 'bot', respuesta);
                return;
            }

            await notificarTelegramComprobante(
                conv.nombre_cliente || numero,
                producto.nombre,
                producto.precio
            );

            const venta = await Venta.create({
                numero_wa:      numero,
                nombre_cliente: conv.nombre_cliente || nombre,
                email_cliente:  conv.email_cliente  || null,
                producto_id:    producto.id,
                monto:          producto.precio,
                comprobante_url: 'comprobante_recibido',
                estado:         'completada',
                link_enviado:   producto.link_drive,
                fecha:          new Date().toISOString().slice(0, 10)
            });
            await CajaMovimiento.create({
                tipo:     'ingreso',
                monto:    producto.precio,
                concepto: `Venta ${producto.nombre} — ${conv.nombre_cliente || numero}`,
                venta_id: venta.id,
                fecha:    new Date().toISOString().slice(0, 10)
            });

            const notas = {
                ...(conv.notas || {}),
                producto_comprado_id: producto.id,
                comprado_at: Date.now()
            };
            await conv.update({ estado: 'completado', producto_id: null, notas });

            await notificarTelegramVenta(
                conv.nombre_cliente || numero,
                producto.nombre,
                producto.precio,
                conv.email_cliente
            );

            const esN8n = producto.nombre.toLowerCase().includes('n8n') || producto.nombre.toLowerCase().includes('agente');
            const respuesta = esN8n
                ? `✅ *¡Pago confirmado!* Gracias por tu compra 🎉\n\n1️⃣ Aquí tienes tus accesos 👇\n👉 Ingresa con el correo que registramos. Si la carpeta aparece vacía, espera 1 minuto mientras cargan los archivos.\n\n${producto.link_drive}\n\n2️⃣ 🛑 Te agradezco si nos dejas un comentario en nuestra publicación 😉\nhttps://www.facebook.com/share/p/1GEdB3GX1L/\n\n3️⃣ *IMPORTANTE* — Antes de instalar, mira este video de YouTube que explica cómo tener un VPS gratuito por 6 meses 💻\nhttps://www.youtube.com/watch?v=xv_nfpnXiL8\n\n4️⃣ VPS gratis 6 meses 👆 (mira primero el video de arriba)\nhttps://aws.amazon.com/es/free/`
                : `✅ *¡Pago confirmado!* Gracias por tu compra 🎉\n\n🔗 Aquí está tu acceso a *${producto.nombre}*:\n${producto.link_drive}\n\n📌 Guarda este enlace. Es de uso personal y de por vida.\n🛑 Si nos dejas un comentario te lo agradecemos mucho 😉\nhttps://www.facebook.com/share/p/1GEdB3GX1L/\n\n¡Que lo disfrutes! 🙌`;
            await enviarTexto(numero, respuesta);
            await guardarHistorial(conv, 'bot', respuesta);
            return;
        }
        // Imagen fuera de contexto — pasarla a la IA por si contiene pregunta
        const productos   = await getProductos();
        const iaRespuesta = await respuestaIA('El cliente envió una imagen', conv, productos);
        const respuesta   = iaRespuesta || '📸 Recibí tu imagen. Si ya pagaste y estás esperando el acceso, cuéntame qué producto compraste. Escribe *menú* para ver los productos.';
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    if (!msg) return;

    await guardarHistorial(conv, 'user', msg);

    const productos = await getProductos();

    // ── Saludo: si tiene historial previo, Sofía retoma la conversación ──────────
    const esComandoMenu = ['menú', 'menu', 'inicio', 'start', 'menú principal'].includes(msgLower);
    const esSaludo = ['hola', 'hi', 'buenos días', 'buenas', 'buenas noches', 'buenas tardes', 'buen día'].includes(msgLower);
    const tieneHistorial = (conv.historial || []).length > 1;

    if (esComandoMenu || estado === 'nuevo') {
        const respuesta = menuTexto(productos);
        await conv.update({ estado: 'menu', producto_id: null });
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // Saludo con historial → Sofía retoma con contexto en vez de mostrar menú genérico
    if (esSaludo && tieneHistorial) {
        const contextoSaludo = estado === 'esperando_comprobante'
            ? 'El cliente regresa. Estaba a punto de pagar. Recuérdale amablemente que quedó pendiente el comprobante de pago y anímate a cerrar la venta.'
            : conv.producto_id
            ? 'El cliente regresa. Muéstrate contento de verlo de nuevo y retoma la conversación donde quedaron, recordándole el producto que le interesaba.'
            : 'El cliente regresa. Salúdalo con calidez y pregúntale en qué le puedes ayudar hoy.';
        const iaRespuesta = await respuestaIA(contextoSaludo, conv, productos);
        const respuesta = iaRespuesta || menuTexto(productos);
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // Saludo sin historial → menú normal
    if (esSaludo) {
        const respuesta = menuTexto(productos);
        await conv.update({ estado: 'menu', producto_id: null });
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // Selección por número
    const num = parseInt(msgLower);
    if (!isNaN(num) && num >= 1 && num <= productos.length && ['menu', 'nuevo', 'completado'].includes(estado)) {
        const producto = productos[num - 1];
        await conv.update({ estado: 'esperando_email', producto_id: producto.id });
        const respuesta = detalleProducto(producto);
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // Capturar email — también funciona en flujo IA (no solo 'esperando_email')
    const emailMatch = msg.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch && conv.producto_id && !conv.email_cliente) {
        const email    = emailMatch[0].toLowerCase();
        const producto = await Producto.findByPk(conv.producto_id);
        await conv.update({ estado: 'esperando_comprobante', email_cliente: email });
        const respuesta = mensajePago(producto);
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // ── Todo lo demás: IA con metodología de dolor ────────────────────────────
    const iaRespuesta = await respuestaIA(msg, conv, productos);
    if (iaRespuesta) {
        const updateData = {};
        // Si la IA menciona un producto, guardar producto_id
        for (const p of productos) {
            if (iaRespuesta.includes(p.nombre) && !conv.producto_id) {
                updateData.producto_id = p.id;
                break;
            }
        }
        // Si la IA está dando datos de pago (Nequi, comprobante), pasar a esperando_comprobante
        const mencionaPago = /nequi|daviplata|comprobante|transferencia|bre-b|llave/i.test(iaRespuesta);
        if (mencionaPago && conv.producto_id) {
            updateData.estado = 'esperando_comprobante';
        }
        if (Object.keys(updateData).length) await conv.update(updateData);
        await enviarTexto(numero, iaRespuesta);
        await guardarHistorial(conv, 'bot', iaRespuesta);
    } else {
        const respuesta = menuTexto(productos);
        await conv.update({ estado: 'menu' });
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
    }
}

module.exports = { procesarMensaje, notificarTelegram, enviarUpsell };
