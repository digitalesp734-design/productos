const { Producto, Conversacion, Venta, CajaMovimiento } = require('../models');
const { enviarTexto, descargarMedia } = require('./whatsappService');

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

// ── Detectar comprobante con OpenAI Vision ────────────────────────────────────
async function esComprobante(mediaId) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return true;
    try {
        const { buffer } = await descargarMedia(mediaId) || {};
        if (!buffer) return false;
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

function detalleProducto(p) {
    return `🔥 *${p.nombre}*\n💰 Precio: ${fmt(p.precio)} (pago único)\n\n${p.descripcion || ''}\n\n📲 *¿Cómo comprar?*\n1. Paga por Nequi, Daviplata o transferencia\n2. Envíame el *comprobante de pago* (foto/captura)\n3. Te envío el acceso inmediatamente ✅\n\n¿Tienes preguntas? Pregúntame con confianza 😊\n¿Ver reseñas? Escribe *reseñas*`;
}

// ── Respuesta IA para preguntas generales ─────────────────────────────────────
async function respuestaIA(msg, conv, productos) {
    const catalogo = productos.map((p, i) => `${i + 1}. ${p.nombre} — ${fmt(p.precio)}: ${p.descripcion?.slice(0, 100)}`).join('\n');
    const sistema = `Eres Carlos, el mejor vendedor de Product Digital, una tienda colombiana de productos digitales con años de experiencia. Eres carismático, cercano, persuasivo y SIEMPRE cierras la venta.

CATÁLOGO ACTUAL:
${catalogo}

TU ESTILO DE VENTA:
- Habla en español colombiano informal (tuteo, "parcero", "listo", "claro que sí")
- Eres entusiasta y transmites confianza total en los productos
- Usas escasez y urgencia cuando es necesario ("esto lo tienen pocos", "es por tiempo limitado")
- Resaltas el valor antes que el precio ("por menos de un almuerzo tienes acceso de POR VIDA")
- Maneja objeciones con seguridad: si dicen "está caro" → compara con el valor real, "es seguro" → explica garantía y años en el mercado
- Cuando alguien muestra interés, empuja hacia el cierre: "¿Lo pedimos ya?"
- Celebra cuando el cliente decide comprar 🎉
- Máximo 4 líneas por respuesta — corto, directo y contundente
- Usa emojis con moderación para dar energía ✅🔥💰

REGLAS ESTRICTAS:
- Nunca inventes productos ni precios fuera del catálogo
- El pago es por Nequi, Daviplata o transferencia bancaria
- Si ya eligieron, pide el comprobante de pago
- Si preguntan si es seguro: "Llevamos años vendiendo, más de X clientes satisfechos, si no queda contento le devolvemos"
- Si no saben qué comprar, recomienda según lo que necesitan`;

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
async function procesarMensaje({ numero, nombre, tipo, texto, mediaId }) {
    let conv = await Conversacion.findOne({ where: { numero_wa: numero } });
    if (!conv) {
        conv = await Conversacion.create({ numero_wa: numero, nombre_cliente: nombre, estado: 'nuevo', historial: [] });
    } else if (nombre && !conv.nombre_cliente) {
        await conv.update({ nombre_cliente: nombre });
    }

    const estado = conv.estado;
    const msg = (texto || '').trim();
    const msgLower = msg.toLowerCase();

    // ── Imagen: puede ser comprobante ─────────────────────────────────────────
    if (tipo === 'image' && mediaId) {
        if (estado === 'esperando_comprobante' && conv.producto_id) {
            const producto = await Producto.findByPk(conv.producto_id);
            if (!producto) {
                await enviarTexto(numero, 'Error interno. Escribe *menú* para reiniciar.');
                return;
            }
            const confirmado = await esComprobante(mediaId);
            if (!confirmado) {
                const respuesta = '🤔 Esa imagen no parece un comprobante de pago. Por favor envía la *captura del comprobante* (Nequi, Daviplata, transferencia, etc.)';
                await enviarTexto(numero, respuesta);
                await guardarHistorial(conv, 'bot', respuesta);
                return;
            }
            const mediaUrl = `https://graph.facebook.com/v21.0/${mediaId}`;
            const venta = await Venta.create({
                numero_wa: numero, nombre_cliente: conv.nombre_cliente || nombre,
                producto_id: producto.id, monto: producto.precio,
                comprobante_url: mediaUrl, estado: 'completada', link_enviado: producto.link_drive,
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
        await conv.update({ estado: 'esperando_comprobante', producto_id: producto.id });
        const respuesta = detalleProducto(producto);
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // ── Respuesta con IA para todo lo demás ───────────────────────────────────
    const iaRespuesta = await respuestaIA(msg, conv, productos);
    if (iaRespuesta) {
        // Detectar si la IA sugirió un producto específico → actualizar estado
        productos.forEach(async (p, i) => {
            if (iaRespuesta.includes(p.nombre) && estado === 'menu') {
                await conv.update({ estado: 'esperando_comprobante', producto_id: p.id });
            }
        });
        await enviarTexto(numero, iaRespuesta);
        await guardarHistorial(conv, 'bot', iaRespuesta);
    } else {
        // Fallback sin OpenAI
        const respuesta = menuTexto(productos);
        await conv.update({ estado: 'menu' });
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
    }
}

module.exports = { procesarMensaje };
