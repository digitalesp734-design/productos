const { Producto, Conversacion, Venta, CajaMovimiento } = require('../models');
const { enviarTexto, descargarMedia } = require('./whatsappService');

// ── Detectar comprobante con OpenAI Vision ────────────────────────────────────
async function esComprobante(mediaId) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return true; // sin OpenAI, aceptar todo

    try {
        const { buffer } = await descargarMedia(mediaId) || {};
        if (!buffer) return false;

        const base64 = buffer.toString('base64');
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                max_tokens: 50,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Esta imagen, ¿es un comprobante o recibo de pago (transferencia bancaria, Nequi, Daviplata, depósito, consignación)? Responde solo SI o NO.' },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } }
                    ]
                }]
            })
        });
        const data = await r.json();
        const respuesta = data.choices?.[0]?.message?.content?.trim().toUpperCase() || '';
        return respuesta.startsWith('SI') || respuesta.startsWith('SÍ');
    } catch (e) {
        console.error('Vision error:', e.message);
        return true; // en caso de error, aceptar
    }
}

// ── Formatear precio ──────────────────────────────────────────────────────────
const fmt = p => `$${parseInt(p).toLocaleString('es-CO')}`;

// ── Menú principal ────────────────────────────────────────────────────────────
async function menuProductos() {
    const productos = await Producto.findAll({ where: { activo: true }, order: [['orden', 'ASC']] });
    let texto = '¡Hola! 👋 Bienvenido a *Product Digital* 🛒\n\nSomos una tienda de productos digitales con años en el mercado. Tenemos todo lo que necesitas:\n\n';
    productos.forEach((p, i) => {
        texto += `*${i + 1}.* ${p.nombre} — ${fmt(p.precio)}\n`;
    });
    texto += '\n💡 Escribe el *número* del producto que te interesa para ver más detalles.\n\n✅ Pagos únicos de por vida. Sin mensualidades.';
    return { texto, productos };
}

// ── Detalle de un producto ────────────────────────────────────────────────────
function detalleProducto(p) {
    return `🔥 *${p.nombre}*\n💰 Precio: ${fmt(p.precio)} (pago único de por vida)\n\n${p.descripcion || ''}\n\n📲 Para adquirirlo:\n1. Realiza el pago por Nequi, Daviplata o transferencia\n2. Envíame el *comprobante de pago*\n3. Te envío el acceso inmediatamente ✅\n\n¿Quieres ver reseñas de clientes? Escribe *reseñas* 📸\n¿Preguntas? Escríbeme y con gusto te respondo 😊`;
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
    const msg = (texto || '').trim().toLowerCase();

    // ── Imagen recibida — puede ser comprobante ───────────────────────────────
    if (tipo === 'image' && mediaId) {
        if (estado === 'esperando_comprobante' && conv.producto_id) {
            const producto = await Producto.findByPk(conv.producto_id);
            if (!producto) { await enviarTexto(numero, 'Error interno. Escribe *menú* para reiniciar.'); return; }

            const confirmado = await esComprobante(mediaId);
            if (!confirmado) {
                await enviarTexto(numero, '🤔 Esa imagen no parece un comprobante de pago. Por favor envía la *captura del comprobante* (Nequi, Daviplata, transferencia, etc.)');
                return;
            }

            // Registrar venta
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

            await enviarTexto(numero,
                `✅ *¡Pago confirmado!* Gracias por tu compra 🎉\n\n🔗 Aquí está tu acceso a *${producto.nombre}*:\n${producto.link_drive}\n\n📌 Guarda este enlace. Es de uso personal y de por vida.\n¡Que lo disfrutes! 🙌`
            );
            return;
        }

        // Imagen fuera de contexto
        await enviarTexto(numero, '📸 Recibí tu imagen. Si ya hiciste el pago, primero dime qué producto compraste. Escribe *menú* para ver los productos.');
        return;
    }

    // ── Comandos de texto ─────────────────────────────────────────────────────
    if (!msg) return;

    // Reinicio
    if (msg === 'menú' || msg === 'menu' || msg === 'hola' || msg === 'inicio' || estado === 'nuevo') {
        const { texto: menuTexto, productos } = await menuProductos();
        await conv.update({ estado: 'menu', producto_id: null });
        await enviarTexto(numero, menuTexto);
        return;
    }

    // Reseñas / testimonios
    if (msg.includes('reseña') || msg.includes('resena') || msg.includes('testimonio') || msg.includes('prueba')) {
        await enviarTexto(numero,
            '⭐ *Clientes satisfechos nos respaldan*\n\nLlevamos años en el mercado vendiendo productos digitales de calidad. Aquí algunos comentarios:\n\n💬 "Excelente, me llegó al instante" — Carlos M.\n💬 "Todo funcionando perfectamente, recomendado 100%" — Laura G.\n💬 "Ya llevo 2 compras y siempre perfecto" — Andrés R.\n💬 "Rápido y confiable, volveré a comprar" — María F.\n\n🔒 Tu pago es seguro. Si tienes alguna duda, pregúntame.'
        );
        return;
    }

    // Selección de producto por número
    if (estado === 'menu' || estado === 'viendo_producto') {
        const { productos } = await menuProductos();
        const num = parseInt(msg);
        if (!isNaN(num) && num >= 1 && num <= productos.length) {
            const producto = productos[num - 1];
            await conv.update({ estado: 'esperando_comprobante', producto_id: producto.id });
            await enviarTexto(numero, detalleProducto(producto));
            return;
        }

        // Buscar producto por nombre
        const porNombre = productos.find(p => p.nombre.toLowerCase().includes(msg) || msg.includes(p.nombre.toLowerCase().split(' ')[0]));
        if (porNombre) {
            await conv.update({ estado: 'esperando_comprobante', producto_id: porNombre.id });
            await enviarTexto(numero, detalleProducto(porNombre));
            return;
        }
    }

    // Ya seleccionó producto, esperando comprobante
    if (estado === 'esperando_comprobante') {
        if (msg.includes('pagué') || msg.includes('pague') || msg.includes('listo') || msg.includes('ya pagué') || msg.includes('transferí')) {
            await enviarTexto(numero, '📲 Perfecto! Ahora envíame la *foto del comprobante* de pago (captura de Nequi, Daviplata, transferencia, etc.) y te envío el acceso inmediatamente ✅');
            return;
        }
        if (msg.includes('precio') || msg.includes('costo') || msg.includes('valor')) {
            const producto = await Producto.findByPk(conv.producto_id);
            if (producto) { await enviarTexto(numero, `El precio de *${producto.nombre}* es ${fmt(producto.precio)} — pago único de por vida. 💳 Puedes pagar por Nequi, Daviplata o transferencia bancaria.`); return; }
        }
        await enviarTexto(numero, '⬆️ Cuando hayas hecho el pago, envíame la *foto del comprobante* y te entrego el acceso al instante. Si quieres ver otro producto, escribe *menú*.');
        return;
    }

    // Respuesta genérica
    const { texto: menuTexto } = await menuProductos();
    await conv.update({ estado: 'menu' });
    await enviarTexto(numero, menuTexto);
}

module.exports = { procesarMensaje };
