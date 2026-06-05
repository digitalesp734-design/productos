const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { Producto, Conversacion, Venta, CajaMovimiento } = require('../models');
const { enviarTexto, enviarAudio } = require('./whatsappService');

const fmt = p => `$${parseInt(p).toLocaleString('es-CO')}`;

function getAnthropic() {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Claude: respuestas MUY cortas tipo WhatsApp real ─────────────────────────
async function claudeChat(systemPrompt, historialMsgs, userMsg) {
    try {
        const client = getAnthropic();
        const msgs   = [...historialMsgs, { role: 'user', content: userMsg }];
        const resp   = await client.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 180,
            system:     systemPrompt,
            messages:   msgs
        });
        return resp.content[0]?.text?.trim() || null;
    } catch (e) {
        console.error('Claude error:', e.message);
        return null;
    }
}

// ── Transcribir audio con Whisper ─────────────────────────────────────────────
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
            method:  'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body:    form
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
        const resp   = await client.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 10,
            messages:   [{
                role:    'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') } },
                    { type: 'text',  text: '¿Es esta imagen un comprobante de pago (Nequi, Daviplata, transferencia, consignación)? Responde solo SI o NO.' }
                ]
            }]
        });
        const r = (resp.content[0]?.text || '').toUpperCase().trim();
        return r.startsWith('SI') || r.startsWith('SÍ');
    } catch (e) {
        console.error('Vision error:', e.message);
        try { await notificarTelegram('⚠️ Vision falló — revisar comprobante manualmente'); } catch {}
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
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ chat_id: chatId, text: mensaje, parse_mode: 'Markdown' })
        });
    } catch (e) { console.error('Telegram error:', e.message); }
}

async function notificarTelegramVenta(cliente, producto, monto, email) {
    await notificarTelegram(`🎉 *¡VENTA!*\n👤 ${cliente}\n📦 ${producto}\n💰 ${fmt(monto)}\n📧 ${email || '—'}`);
}

// ── Catálogo ──────────────────────────────────────────────────────────────────
async function getProductos() {
    return Producto.findAll({ where: { activo: true }, order: [['orden', 'ASC']] });
}

function menuTexto(productos) {
    let t = '👋 ¿Qué necesitas?\n\n';
    productos.forEach((p, i) => { t += `*${i + 1}.* ${p.nombre} — *${fmt(p.precio)}*\n`; });
    t += '\n📲 Escribe el número que te interesa';
    return t;
}

function infoPago(monto) {
    const nequi     = process.env.NEQUI_NUMERO    || '';
    const daviplata = process.env.DAVIPLATA_NUMERO || '';
    const llave     = process.env.LLAVE_NUMERO     || '';
    const nombre    = process.env.PAGO_NOMBRE      || '';
    let txt = `💳 *Pago — ${fmt(monto)}:*\n`;
    if (nequi)     txt += `📱 Nequi: ${nequi}\n`;
    if (daviplata) txt += `📱 Daviplata: ${daviplata}\n`;
    if (llave)     txt += `🔑 Bre-b: ${llave}\n`;
    if (nombre)    txt += `👤 ${nombre}\n`;
    return txt;
}

// ── Link de agentes n8n para cuando pregunten ────────────────────────────────
const LINK_AGENTES_N8N = 'https://docs.google.com/spreadsheets/d/1RTXROtQqnyh4yC4n5U-DiKR9x0aWz_l8w1QmK1pr-ik/edit?usp=sharing';

// ── Audio pregrabado del producto (matching por nombre) ───────────────────────
function getAudioProducto(nombreProducto) {
    const AUDIO_DIR = path.join(__dirname, '../assets/audios');
    const nombre    = (nombreProducto || '').toLowerCase();
    let archivo = null;
    if (nombre.includes('capcut'))              archivo = 'capcut.ogg';
    else if (nombre.includes('n8n') || nombre.includes('agente')) archivo = 'n8n.ogg';
    if (!archivo) return null;
    const ruta = path.join(AUDIO_DIR, archivo);
    return fs.existsSync(ruta) ? fs.readFileSync(ruta) : null;
}

// ── Sistema prompt ultra-compacto, WhatsApp real ──────────────────────────────
function buildSystemPrompt(productos) {
    const lista = productos.map((p, i) => `${i + 1}. ${p.nombre} (${fmt(p.precio)})`).join('\n');
    const nequi     = process.env.NEQUI_NUMERO     || '';
    const daviplata = process.env.DAVIPLATA_NUMERO || '';
    const llave     = process.env.LLAVE_NUMERO     || '';
    const pagNombre = process.env.PAGO_NOMBRE      || '';

    return `Eres una vendedora real por WhatsApp. Nombre: Sofía. Vendes productos digitales.

PRODUCTOS:
${lista}

PAGO: Nequi ${nequi}${daviplata ? ' / Daviplata ' + daviplata : ''}${llave ? ' / Bre-b ' + llave : ''}${pagNombre ? ' — ' + pagNombre : ''}

REGLAS ABSOLUTAS:
- Máximo 2-3 líneas por mensaje. NUNCA más.
- Escribe como persona real en WhatsApp, no como chatbot
- Una sola pregunta a la vez, nunca varias
- Si preguntan por un producto específico, ve directo a ese
- Si seleccionan número, pide el correo para el acceso
- Si dan correo, da los datos de pago
- Si ya pagaron, pide el comprobante (foto)
- Objeciones: responde corto + pregunta de cierre
- NUNCA hagas listas largas ni párrafos explicativos
- Tono: cálido, directo, natural`;
}

// ── Respuesta IA ──────────────────────────────────────────────────────────────
async function respuestaIA(msg, conv, productos) {
    const sistema   = buildSystemPrompt(productos);
    const historial = (conv.historial || []).slice(-10).map(h => ({
        role:    h.rol === 'bot' ? 'assistant' : 'user',
        content: h.texto
    }));
    return claudeChat(sistema, historial, msg);
}

// ── Guardar historial ─────────────────────────────────────────────────────────
async function guardarHistorial(conv, rol, texto) {
    const historial = [...(conv.historial || []), { rol, texto, ts: Date.now() }].slice(-30);
    await conv.update({ historial, ultimo_mensaje: texto.slice(0, 200) });
}

// ── Enviar detalle del producto (texto + audio si existe) ─────────────────────
async function enviarDetalleProducto(numero, producto) {
    const audio  = getAudioProducto(producto.nombre);
    const esN8n  = /n8n|agente/i.test(producto.nombre);

    if (audio) {
        const intro = `🔥 *${producto.nombre}* — ${fmt(producto.precio)} pago único\n\nEscucha los detalles 👇`;
        await enviarTexto(numero, intro);
        await new Promise(r => setTimeout(r, 700));
        await enviarAudio(numero, audio);
        await new Promise(r => setTimeout(r, 600));

        // Si es n8n, enviar link de la lista de agentes
        if (esN8n) {
            await enviarTexto(numero, `📋 Aquí puedes ver la lista completa de los 350 agentes:\n${LINK_AGENTES_N8N}`);
            await new Promise(r => setTimeout(r, 500));
        }
        await enviarTexto(numero, '¿Cuál es tu correo? Te envío el acceso al instante 📧');
    } else {
        const msg = `🔥 *${producto.nombre}*\n💰 ${fmt(producto.precio)} — pago único de por vida\n\n${(producto.descripcion || '').slice(0, 120)}\n\n¿Cuál es tu correo? 📧`;
        await enviarTexto(numero, msg);
        if (esN8n) {
            await new Promise(r => setTimeout(r, 500));
            await enviarTexto(numero, `📋 Lista completa de los 350 agentes:\n${LINK_AGENTES_N8N}`);
        }
    }
}

// ── Procesar mensaje entrante ─────────────────────────────────────────────────
async function procesarMensaje({ numero, nombre, tipo, texto, mediaBuffer }) {
    let conv = await Conversacion.findOne({ where: { numero_wa: numero } });
    if (!conv) {
        conv = await Conversacion.create({
            numero_wa:       numero,
            nombre_cliente:  nombre,
            estado:          'nuevo',
            historial:       [],
            notas:           {}
        });
    } else if (nombre && !conv.nombre_cliente) {
        await conv.update({ nombre_cliente: nombre });
    }

    const estado   = conv.estado;
    const msg      = (texto || '').trim();
    const msgLower = msg.toLowerCase();

    // ── Audio entrante ────────────────────────────────────────────────────────
    if (tipo === 'audio' && mediaBuffer) {
        await guardarHistorial(conv, 'user', '🎤 [audio]');
        const transcripcion = await transcribirAudio(mediaBuffer);
        if (transcripcion) {
            const productos   = await getProductos();
            const iaRespuesta = await respuestaIA(transcripcion, conv, productos);
            const respuesta   = iaRespuesta || '¿Me puedes escribir tu pregunta? 😊';
            await enviarTexto(numero, respuesta);
            await guardarHistorial(conv, 'bot', respuesta);
        } else {
            await enviarTexto(numero, '¿Me puedes escribir tu pregunta? 😊');
        }
        return;
    }

    // ── Imagen entrante ───────────────────────────────────────────────────────
    if (tipo === 'image' && mediaBuffer) {
        if (conv.producto_id) {
            const producto   = await Producto.findByPk(conv.producto_id);
            if (!producto) { await enviarTexto(numero, 'Escribe *menú* para reiniciar'); return; }

            const confirmado = await esComprobante(mediaBuffer);
            if (!confirmado) {
                await enviarTexto(numero, 'No parece un comprobante 🤔 Envíame la captura del pago (Nequi, Daviplata, etc.)');
                return;
            }

            // Registrar venta
            const venta = await Venta.create({
                numero_wa:       numero,
                nombre_cliente:  conv.nombre_cliente || nombre,
                email_cliente:   conv.email_cliente  || null,
                producto_id:     producto.id,
                monto:           producto.precio,
                comprobante_url: 'comprobante_recibido',
                estado:          'completada',
                link_enviado:    producto.link_drive,
                fecha:           new Date().toISOString().slice(0, 10)
            });
            await CajaMovimiento.create({
                tipo:     'ingreso',
                monto:    producto.precio,
                concepto: `Venta ${producto.nombre} — ${conv.nombre_cliente || numero}`,
                venta_id: venta.id,
                fecha:    new Date().toISOString().slice(0, 10)
            });
            await conv.update({ estado: 'completado', producto_id: null, notas: { ...(conv.notas || {}), producto_comprado_id: producto.id, comprado_at: Date.now() } });

            await notificarTelegramVenta(conv.nombre_cliente || numero, producto.nombre, producto.precio, conv.email_cliente);

            const esN8n = /n8n|agente/i.test(producto.nombre);
            const respuesta = esN8n
                ? `✅ *¡Listo!* Aquí tus accesos 🎉\n\n${producto.link_drive}\n\n📌 Antes de instalar mira este video (VPS gratis 6 meses):\nhttps://www.youtube.com/watch?v=xv_nfpnXiL8\n\n🛑 Si nos dejas un comentario te lo agradecemos 🙏\nhttps://www.facebook.com/share/p/1GEdB3GX1L/`
                : `✅ *¡Listo!* Aquí está tu acceso 🎉\n\n${producto.link_drive}\n\n📌 Guárdalo — es de por vida.\n🛑 Un comentario nos ayuda mucho 🙏\nhttps://www.facebook.com/share/p/1GEdB3GX1L/`;
            await enviarTexto(numero, respuesta);
            await guardarHistorial(conv, 'bot', respuesta);
            return;
        }
        // Imagen sin contexto → IA
        const productos   = await getProductos();
        const iaRespuesta = await respuestaIA('El cliente envió una imagen', conv, productos);
        await enviarTexto(numero, iaRespuesta || '¿En qué te puedo ayudar? 😊');
        return;
    }

    if (!msg) return;
    await guardarHistorial(conv, 'user', msg);

    const productos = await getProductos();

    // ── Comando menú ──────────────────────────────────────────────────────────
    const esComandoMenu = ['menú', 'menu', 'inicio', 'start'].includes(msgLower);
    if (esComandoMenu) {
        const respuesta = menuTexto(productos);
        await conv.update({ estado: 'menu', producto_id: null });
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // ── Primer mensaje (estado nuevo) → IA entiende el contexto ──────────────
    // No mostrar menú completo ciegamente. Dejar que la IA responda según lo que dijo.
    if (estado === 'nuevo') {
        const iaRespuesta = await respuestaIA(msg, conv, productos);
        const respuesta   = iaRespuesta || menuTexto(productos);
        await conv.update({ estado: 'activo' });
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // ── Selección por número ──────────────────────────────────────────────────
    const num = parseInt(msgLower);
    if (!isNaN(num) && num >= 1 && num <= productos.length) {
        const producto = productos[num - 1];
        await conv.update({ estado: 'esperando_email', producto_id: producto.id });
        await enviarDetalleProducto(numero, producto);
        const detalleTexto = `🔥 ${producto.nombre} — ${fmt(producto.precio)}`;
        await guardarHistorial(conv, 'bot', detalleTexto);
        return;
    }

    // ── Captura de email ──────────────────────────────────────────────────────
    const emailMatch = msg.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch && conv.producto_id && !conv.email_cliente) {
        const email    = emailMatch[0].toLowerCase();
        const producto = await Producto.findByPk(conv.producto_id);
        await conv.update({ estado: 'esperando_comprobante', email_cliente: email });
        const respuesta = `Perfecto ✅ Anota los datos de pago:\n\n${infoPago(producto.precio)}\nEnvíame la captura cuando pagues y en segundos tienes el acceso ⚡`;
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // ── Si pregunta por la lista de agentes n8n, dar el link directo ────────────
    if (/agentes?|lista|cuáles|cuales|qué agentes|que agentes|350/i.test(msgLower) && /n8n/i.test(msgLower + (conv.ultimo_mensaje || ''))) {
        const respuesta = `📋 Aquí está la lista completa de los 350 agentes incluidos:\n${LINK_AGENTES_N8N}\n\n¿Cuál es tu correo para enviarte el acceso? 📧`;
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // ── Todo lo demás: IA ─────────────────────────────────────────────────────
    const iaRespuesta = await respuestaIA(msg, conv, productos);
    if (iaRespuesta) {
        const updateData = {};
        for (const p of productos) {
            if (iaRespuesta.includes(p.nombre) && !conv.producto_id) {
                updateData.producto_id = p.id;
                break;
            }
        }
        const mencionaPago = /nequi|daviplata|comprobante|transferencia|bre-b/i.test(iaRespuesta);
        if (mencionaPago && conv.producto_id) updateData.estado = 'esperando_comprobante';
        if (!conv.estado || conv.estado === 'nuevo') updateData.estado = 'activo';
        if (Object.keys(updateData).length) await conv.update(updateData);
        await enviarTexto(numero, iaRespuesta);
        await guardarHistorial(conv, 'bot', iaRespuesta);
    } else {
        await enviarTexto(numero, menuTexto(productos));
        await conv.update({ estado: 'menu' });
    }
}

// ── Upsell post-compra ────────────────────────────────────────────────────────
async function enviarUpsell(conv) {
    try {
        const productos = await getProductos();
        const comprado  = conv.notas?.producto_comprado_id;
        const otros     = productos.filter(p => p.id !== comprado);
        if (!otros.length) return;
        const sugerido  = otros.find(p => p.es_combo) || otros[0];
        const msg = `👋 Espero que estés disfrutando tu compra.\n\nTe puede interesar: *${sugerido.nombre}* — ${fmt(sugerido.precio)} de por vida\n\n¿Te cuento más? 😊`;
        await enviarTexto(conv.numero_wa, msg);
        await guardarHistorial(conv, 'bot', msg);
    } catch (e) { console.error('Upsell error:', e.message); }
}

module.exports = { procesarMensaje, notificarTelegram, enviarUpsell };
