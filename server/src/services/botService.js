const { Producto, Conversacion, Venta, CajaMovimiento } = require('../models');
const { enviarTexto } = require('./whatsappService');

const fmt = p => `$${parseInt(p).toLocaleString('es-CO')}`;

// ── OpenAI helper ─────────────────────────────────────────────────────────────
async function openaiChat(messages, max_tokens = 400) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens, messages })
        });
        const d = await r.json();
        return d.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) { console.error('OpenAI error:', e.message); return null; }
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
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form
        });
        const d = await r.json();
        return d.text?.trim() || null;
    } catch (e) { console.error('Whisper error:', e.message); return null; }
}

// ── Detectar comprobante con OpenAI Vision ────────────────────────────────────
async function esComprobante(buffer) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return true;
    if (!buffer) return false;
    try {
        const base64 = buffer.toString('base64');
        const respuesta = await openaiChat([{
            role: 'user',
            content: [
                { type: 'text', text: 'Esta imagen, ¿es un comprobante o recibo de pago (transferencia bancaria, Nequi, Daviplata, depósito, consignación)? Responde solo SI o NO.' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } }
            ]
        }], 10);
        return (respuesta || '').toUpperCase().startsWith('SI') || (respuesta || '').toUpperCase().startsWith('SÍ');
    } catch (e) { console.error('Vision error:', e.message); return true; }
}

// ── Catálogo de productos ─────────────────────────────────────────────────────
async function getProductos() {
    return Producto.findAll({ where: { activo: true }, order: [['orden', 'ASC']] });
}

function menuTexto(productos) {
    let t = '¡Hola! 👋 Bienvenido a *Product Digital* 🛒\n\nTenemos los mejores productos digitales:\n\n';
    productos.forEach((p, i) => { t += `*${i + 1}.* ${p.nombre} — ${fmt(p.precio)}\n`; });
    t += '\n💡 Escribe el *número* del producto que te interesa.\n✅ Pago único de por vida. Sin mensualidades.';
    return t;
}

function infoPago(monto) {
    const nequi  = process.env.NEQUI_NUMERO  || '';
    const llaves = process.env.LLAVES_EMAIL  || '';

    let txt = `💳 *Formas de pago — ${fmt(monto)}:*\n\n`;
    if (nequi)  txt += `📱 *Nequi:* ${nequi}\n`;
    if (llaves) txt += `🔑 *Llaves / Transferencia:* ${llaves}\n`;
    return txt;
}

function detalleProducto(p) {
    return `🔥 *${p.nombre}*\n💰 Precio: ${fmt(p.precio)} (pago único de por vida)\n\n${p.descripcion || ''}\n\n¿Cuál es tu *correo electrónico*? Lo necesito para enviarte el acceso 📧`;
}

function mensajePago(p) {
    return `✅ ¡Perfecto! Aquí están los datos de pago:\n\n${infoPago(p.precio)}\n📸 Una vez pagues, envíame el *comprobante* (captura de pantalla) y te envío el acceso en segundos ⚡`;
}

// ── Respuesta IA para preguntas generales ─────────────────────────────────────
async function respuestaIA(msg, conv, productos) {
    const catalogo = productos.map((p, i) => `${i + 1}. ${p.nombre} — ${fmt(p.precio)}: ${p.descripcion?.slice(0, 100)}`).join('\n');
    const sistema = `Eres Carlos, vendedor estrella de Product Digital. Tu único objetivo es CERRAR LA VENTA en esta conversación. Eres colombiano, cercano, directo y confiable.

CATÁLOGO:
${catalogo}

PROCESO DE VENTA QUE DEBES SEGUIR:
1. CALIFICAR: Pregunta qué necesita o para qué lo usaría (máx 1 pregunta corta)
2. RECOMENDAR: Elige UN solo producto del catálogo que le encaje y preséntalo con emoción
3. CERRAR: Empuja directamente al pago — "¿Lo hacemos ya? Te lo envío en segundos ⚡"
4. OBJECIÓN → REBATIR → CERRAR de nuevo, sin rendirte

FRASES QUE USAS:
- "Parcero eso es exactamente lo que necesitas"
- "Te lo digo de una: esto vale más de lo que cuesta"
- "¿Lo pedimos ya? En minutos tienes el acceso"
- "Miles de personas ya lo tienen, tú no te lo puedes perder"
- "Por menos de un almuerzo tienes esto de POR VIDA"
- "Si no te sirve te devuelvo la plata, así de seguros estamos"

MANEJO DE OBJECIONES:
- "está caro" → "Parcero $20.000 es nada comparado con lo que vale, ¿cuánto pagas en un mes de Netflix? Esto es de por vida"
- "no sé si funciona" → "Llevamos años en esto, miles de clientes satisfechos. Si no queda contento le devuelvo sin preguntas"
- "lo pienso" → "¿Qué le genera duda? Cuénteme y lo resolvemos ya mismo"
- "no tengo plata" → "¿Tiene Nequi? Con $20.000 lo solucionamos hoy"

DATOS DE PAGO REALES (úsalos siempre que cierres):
📱 Nequi: ${process.env.NEQUI_NUMERO || ''}
🔑 Llaves / Transferencia: ${process.env.LLAVES_EMAIL || ''}

REGLAS:
- Máximo 4 líneas por respuesta — corto y contundente
- SIEMPRE termina con una pregunta que lleve al cierre o al pago
- Nunca inventes productos ni precios
- Cuando el cliente diga que sí quiere comprar, primero pide su correo: "¿Cuál es tu correo para enviarte el acceso? 📧"
- Cuando ya tengas el correo, da los datos de pago completos y pide el comprobante
- Usa emojis con energía: ✅🔥💰⚡`;

    const historial = (conv.historial || []).slice(-6).map(h => ({
        role: h.rol === 'bot' ? 'assistant' : 'user',
        content: h.texto
    }));

    return openaiChat([
        { role: 'system', content: sistema },
        ...historial,
        { role: 'user', content: msg }
    ]);
}

// ── Guardar en historial ──────────────────────────────────────────────────────
async function guardarHistorial(conv, rol, texto) {
    const historial = [...(conv.historial || []), { rol, texto, ts: Date.now() }].slice(-30);
    await conv.update({ historial, ultimo_mensaje: texto.slice(0, 200) });
}

// ── Procesar mensaje entrante ─────────────────────────────────────────────────
async function procesarMensaje({ numero, nombre, tipo, texto, mediaBuffer }) {
    let conv = await Conversacion.findOne({ where: { numero_wa: numero } });
    if (!conv) {
        conv = await Conversacion.create({ numero_wa: numero, nombre_cliente: nombre, estado: 'nuevo', historial: [] });
    } else if (nombre && !conv.nombre_cliente) {
        await conv.update({ nombre_cliente: nombre });
    }

    const estado = conv.estado;
    const msg = (texto || '').trim();
    const msgLower = msg.toLowerCase();

    // ── Audio: transcribir con Whisper y procesar como texto ─────────────────
    if (tipo === 'audio' && mediaBuffer) {
        await guardarHistorial(conv, 'user', '🎤 [audio]');
        const transcripcion = await transcribirAudio(mediaBuffer);
        if (transcripcion) {
            console.log('🎤 Audio transcrito:', transcripcion);
            const productos = await getProductos();
            const iaRespuesta = await respuestaIA(transcripcion, conv, productos);
            const respuesta = iaRespuesta || menuTexto(productos);
            await enviarTexto(numero, respuesta);
            await guardarHistorial(conv, 'bot', respuesta);
        } else {
            const respuesta = '🎤 Recibí tu audio pero no pude entenderlo. ¿Puedes escribirme tu pregunta? 😊';
            await enviarTexto(numero, respuesta);
            await guardarHistorial(conv, 'bot', respuesta);
        }
        return;
    }

    // ── Imagen: puede ser comprobante ─────────────────────────────────────────
    if (tipo === 'image' && mediaBuffer) {
        if (estado === 'esperando_comprobante' && conv.producto_id) {
            const producto = await Producto.findByPk(conv.producto_id);
            if (!producto) {
                await enviarTexto(numero, 'Error interno. Escribe *menú* para reiniciar.');
                return;
            }
            const confirmado = await esComprobante(mediaBuffer);
            if (!confirmado) {
                const respuesta = '🤔 Esa imagen no parece un comprobante de pago. Por favor envía la *captura del comprobante* (Nequi, Daviplata, transferencia, etc.)';
                await enviarTexto(numero, respuesta);
                await guardarHistorial(conv, 'bot', respuesta);
                return;
            }
            const venta = await Venta.create({
                numero_wa: numero, nombre_cliente: conv.nombre_cliente || nombre,
                email_cliente: conv.email_cliente || null,
                producto_id: producto.id, monto: producto.precio,
                comprobante_url: 'comprobante_recibido', estado: 'completada',
                link_enviado: producto.link_drive,
                fecha: new Date().toISOString().slice(0, 10)
            });
            await CajaMovimiento.create({
                tipo: 'ingreso', monto: producto.precio,
                concepto: `Venta ${producto.nombre} — ${conv.nombre_cliente || numero}`,
                venta_id: venta.id, fecha: new Date().toISOString().slice(0, 10)
            });
            await conv.update({ estado: 'completado', producto_id: null });
            const respuesta = `✅ *¡Pago confirmado!* Gracias por tu compra 🎉\n\n🔗 Aquí está tu acceso a *${producto.nombre}*:\n${producto.link_drive}\n\n📌 Guarda este enlace. Es de uso personal y de por vida.\n¡Que lo disfrutes! 🙌`;
            await enviarTexto(numero, respuesta);
            await guardarHistorial(conv, 'bot', respuesta);
            return;
        }
        const respuesta = '📸 Recibí tu imagen. Si ya pagaste, primero cuéntame qué producto compraste. Escribe *menú* para ver los productos.';
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    if (!msg) return;

    await guardarHistorial(conv, 'user', msg);

    const productos = await getProductos();

    // ── Comandos directos ─────────────────────────────────────────────────────
    if (['menú', 'menu', 'hola', 'inicio', 'start'].includes(msgLower) || estado === 'nuevo') {
        const respuesta = menuTexto(productos);
        await conv.update({ estado: 'menu', producto_id: null });
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // Selección por número
    const num = parseInt(msgLower);
    if (!isNaN(num) && num >= 1 && num <= productos.length && (estado === 'menu' || estado === 'nuevo' || estado === 'completado')) {
        const producto = productos[num - 1];
        await conv.update({ estado: 'esperando_email', producto_id: producto.id });
        const respuesta = detalleProducto(producto);
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // Capturar email
    const emailMatch = msg.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch && estado === 'esperando_email' && conv.producto_id) {
        const email = emailMatch[0].toLowerCase();
        const producto = await Producto.findByPk(conv.producto_id);
        await conv.update({ estado: 'esperando_comprobante', email_cliente: email });
        const respuesta = mensajePago(producto);
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // ── Respuesta con IA para todo lo demás ───────────────────────────────────
    const iaRespuesta = await respuestaIA(msg, conv, productos);
    if (iaRespuesta) {
        productos.forEach(async (p) => {
            if (iaRespuesta.includes(p.nombre) && estado === 'menu') {
                await conv.update({ estado: 'esperando_comprobante', producto_id: p.id });
            }
        });
        await enviarTexto(numero, iaRespuesta);
        await guardarHistorial(conv, 'bot', iaRespuesta);
    } else {
        const respuesta = menuTexto(productos);
        await conv.update({ estado: 'menu' });
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
    }
}

module.exports = { procesarMensaje };
