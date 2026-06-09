const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { Producto, Conversacion, Venta, CajaMovimiento } = require('../models');
const { enviarTexto, enviarAudio, enviarVideo } = require('./whatsappService');

// Video catálogo de EmulaConsolas — primero busca en volumen Railway, luego en assets
const VIDEO_EMULADORA = process.env.WA_AUTH_FOLDER
    ? path.join(process.env.WA_AUTH_FOLDER, 'emuladora_catalogo.mp4')
    : path.join(__dirname, '../assets/videos/emuladora_catalogo.mp4');
const VIDEO_EMULADORA_FALLBACK = path.join(__dirname, '../assets/videos/emuladora_catalogo.mp4');

// Comprobantes de prueba social
const COMPROBANTES_DIR = process.env.WA_AUTH_FOLDER
    ? path.join(process.env.WA_AUTH_FOLDER, 'comprobantes')
    : path.join(__dirname, '../assets/comprobantes');

function getComprobante() {
    try {
        const dirs = [COMPROBANTES_DIR, path.join(__dirname, '../assets/comprobantes')];
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) continue;
            const archivos = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
            if (!archivos.length) continue;
            const random = archivos[Math.floor(Math.random() * archivos.length)];
            return fs.readFileSync(path.join(dir, random));
        }
    } catch {}
    return null;
}

const fmt = p => `$${parseInt(p).toLocaleString('es-CO')}`;

function getAnthropic() {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Claude Sonnet: vendedor inteligente ──────────────────────────────────────
async function claudeChat(systemPrompt, historialMsgs, userMsg) {
    try {
        const client = getAnthropic();
        const msgs   = [...historialMsgs, { role: 'user', content: userMsg }];
        const resp   = await client.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 400,
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

// ── Detectar producto mencionado en el mensaje ────────────────────────────────
function detectarProductoMencionado(msgLower, productos) {
    for (const p of productos) {
        const n = p.nombre.toLowerCase();
        // Combo primero si lo mencionan explícitamente
        if (n.includes('combo') && (msgLower.includes('combo') || msgLower.includes('recursos') || msgLower.includes('vectores'))) return p;
        if (n.includes('capcut') && !n.includes('combo') && msgLower.includes('capcut')) return p;
        if (n.includes('n8n') && n.includes('premium') && (msgLower.includes('premium') || msgLower.includes('curso') || msgLower.includes('hosting') || msgLower.includes('nube'))) return p;
        if ((n.includes('n8n') || n.includes('agente')) && !n.includes('premium') && (msgLower.includes('n8n') || msgLower.includes('agente'))) return p;
        if (n.includes('emula') && (msgLower.includes('emula') || msgLower.includes('juego') || msgLower.includes('consola') || msgLower.includes('playstation') || msgLower.includes('xbox') || msgLower.includes('nintendo'))) return p;
    }
    return null;
}

// ── Audio pregrabado del producto (matching por nombre) ───────────────────────
function getAudioProducto(nombreProducto) {
    const AUDIO_DIR = path.join(__dirname, '../assets/audios');
    const nombre    = (nombreProducto || '').toLowerCase();
    let archivo = null;
    if (nombre.includes('capcut'))
        archivo = 'capcut.ogg';
    else if (nombre.includes('n8n') || nombre.includes('agente'))
        archivo = 'n8n.ogg';
    if (!archivo) return null;
    const ruta = path.join(AUDIO_DIR, archivo);
    return fs.existsSync(ruta) ? fs.readFileSync(ruta) : null;
}

// ── Sistema prompt con escenarios reales y manejo completo de casos ───────────
function buildSystemPrompt(productos, productoActual = null, intercambios = 0) {
    const nequi     = process.env.NEQUI_NUMERO     || '';
    const daviplata = process.env.DAVIPLATA_NUMERO || '';
    const llave     = process.env.LLAVE_NUMERO     || '';
    const pagNombre = process.env.PAGO_NOMBRE      || '';
    const pago      = `Nequi ${nequi}${daviplata ? ' / Daviplata ' + daviplata : ''}${llave ? ' / Bre-b ' + llave : ''}${pagNombre ? ' — ' + pagNombre : ''}`;

    const esCapcut    = productoActual && /capcut/i.test(productoActual.nombre) && !/combo/i.test(productoActual.nombre);
    const esN8n       = productoActual && /n8n|agente/i.test(productoActual.nombre) && !/premium/i.test(productoActual.nombre);
    const esN8nPremium= productoActual && /n8n/i.test(productoActual.nombre) && /premium/i.test(productoActual.nombre);
    const esEmula     = productoActual && /emula/i.test(productoActual.nombre);
    const precio    = productoActual ? fmt(productoActual.precio) : '';

    // ── Bloque de producto actual ──────────────────────────────────────────────
    const bloqueProducto = productoActual ? `
═══════════════════════════════════════
PRODUCTO DE ESTE CLIENTE: "${productoActual.nombre}" — ${precio}
REGLA #1: NUNCA cambies de producto ni menciones otros. Solo hablas de "${productoActual.nombre}".
REGLA #2: NUNCA ofrezcas el combo CapCut a clientes de n8n o EmulaConsolas.
═══════════════════════════════════════
${(esN8n || esN8nPremium) ? `
TENEMOS DOS OPCIONES PARA N8N — preséntaselas al cliente desde el inicio:

OPCIÓN 1 — Pack Básico $20.000 (solo agentes):
  • 350 agentes/workflows listos para importar en n8n
  • Actívalos hoy, sin programar
  • Para quien YA tiene n8n instalado o sabe usarlo

OPCIÓN 2 — Pack Premium $35.000 (curso + agentes + hosting):
  • Todo lo del básico (350 agentes)
  • Curso completo n8n desde cero hasta profesional
  • Instalación y hosting de n8n en la nube 100% GRATIS
  • Para quien quiere APRENDER n8n Y tener las automatizaciones

CÓMO PRESENTAR LAS DOS OPCIONES (hazlo en el primer o segundo intercambio):
  "Tengo dos opciones: el pack básico con los 350 agentes por $20.000, o el premium que incluye además el curso completo desde cero y te dejo n8n en la nube gratis — todo por $35.000. ¿Ya manejas n8n o empezarías desde cero?"

CUÁNDO CERRAR BÁSICO ($20.000): cliente dice que ya tiene n8n, ya sabe usarlo, solo quiere los agentes.
CUÁNDO CERRAR PREMIUM ($35.000): cliente dice que no tiene n8n, no sabe instalarlo, quiere aprender, es nuevo.

CONVERSACIÓN IDEAL:
  Cristian: ¿Qué proceso en tu negocio más tiempo te quita?
  Cliente: responder mensajes de clientes
  Cristian: Ese agente existe — automatiza WhatsApp e IG 24/7. ¿Ya tienes n8n instalado o empezarías desde cero?
  Cliente: no tengo nada, nunca lo he usado
  Cristian: Perfecto — en ese caso el Premium es lo tuyo: incluye el curso desde cero + 350 agentes + te dejo n8n en la nube gratis. Todo por $35.000 de por vida. ¿Me das tu correo?
  Cliente: ya manejo n8n, solo quiero los agentes
  Cristian: Perfecto, el básico es lo que necesitas — $20.000 de por vida, 350 agentes listos para importar. ¿Me das tu correo?

NUNCA ofrezcas el combo CapCut a clientes de n8n.` : ''}
${esCapcut ? `
QUÉ ES: Pack de 3 cursos completos — CapCut PRO, Edición de Video Profesional, Photoshop PRO. Acceso de por vida.
BENEFICIOS REALES: crea reels virales, edita videos profesionales, diseña piezas en Photoshop — todo desde cero.
PARA QUIÉN ES: emprendedores, negocios en redes, creadores de contenido, freelancers de diseño.
CONVERSACIÓN IDEAL:
  Cristian: ¿Ya editas videos o estás empezando desde cero?
  Cliente: empezando
  Cristian: Perfecto, es el pack ideal. Aprendes CapCut PRO, edición profesional y Photoshop — todo por ${precio} de por vida sin mensualidades.
  Cliente: ¿para TikTok sirve?
  Cristian: Sí, el módulo de reels y TikTok está incluido. Tengo clientes que en 2 semanas ya publican contenido profesional. ¿Te animas? Dame tu correo 🚀
COMBO (solo si no ha dado correo ni está pagando): "Oye, tengo algo adicional — un Pack de Recursos completo: vectores, efectos, plantillas listas. Normalmente salen en $50.000 pero te hago el combo en $35.000 — ahorras $15.000 🔥 ¿Te interesa o solo el curso?"` : ''}
${esEmula ? `
QUÉ ES: Software emulador con +16.000 juegos de 32 consolas: PS1, PS2, PS3, Xbox, Xbox 360, Nintendo, SNES, N64, GBA, PC Engine y más. Se instala en PC, tablet o celular. Entrega: link de descarga + tutoriales en YouTube.
JUEGOS INCLUIDOS: God of War, GTA, FIFA, Call of Duty, Mario, Zelda, Sonic, y miles más de cada consola.
CONVERSACIÓN IDEAL:
  Cristian: ¿Tienes PC, celular Android o tablet?
  Cliente: PC
  Cristian: Perfecto, en PC funciona al 100% con todos los emuladores. ¿Cuál era tu consola favorita — PlayStation, Nintendo o Xbox?
  Cliente: PlayStation
  Cristian: En el pack tienes PS1, PS2 y PS3 completos — God of War, GTA, FIFA, todo incluido. Por ${precio} de por vida. ¿Me das tu correo?` : ''}
` : `
Sin producto seleccionado aún. Saluda, pregunta qué busca y dirige al producto correcto.`;

    // ── Manejo de objeciones — respuestas exactas ──────────────────────────────
    const bloqueObjeciones = `
OBJECIONES — USA ESTAS RESPUESTAS EXACTAS:

"está caro / es mucho" →
  "Entiendo. Son ${precio || '$20.000'} una sola vez — sin mensualidades, sin renovaciones, de por vida. ¿Cuánto gastas al mes en apps o suscripciones? Esto es menos. ¿Qué te genera duda del precio?"

"lo pienso / después" →
  "Claro. ¿Qué es lo que más te genera duda? Te lo resuelvo ahora mismo 😊"

"es piratería / es legal?" →
  "Es 100% digital y legal. Son cursos/herramientas propias que vendemos directamente. Llevamos más de 500 compradores y todos reciben su acceso. Si quieres te muestro cómo funciona antes de pagar."

"no tengo plata ahora" →
  "Sin problema 😊 ¿Cuándo crees que podrías? Te recuerdo ese día. Y si en algún momento consigues, escríbeme — el precio es fijo."

"ya existe gratis en YouTube" →
  "Sí, el contenido existe disperso, pero el valor está en tenerlo organizado, con ruta de aprendizaje clara, sin perder horas buscando. Por ${precio || '$20.000'} te ahorras semanas de búsqueda."

"¿tienen soporte?" →
  "Sí. Si tienes dudas al acceder me escribes y te ayudo. También incluye tutoriales de instalación paso a paso."

"¿puedo ver antes de comprar?" →
  "No tenemos demo, pero tenemos compradores que pueden dar referencias. ¿Qué parte específica te genera duda? Te la explico ahora."

"ya pagué pero no recibí nada" →
  "Mándame la captura del comprobante aquí mismo y en segundos te envío el acceso ⚡"

"¿en qué dispositivo funciona?" →
${esEmula ? '  "En PC, tablet y celular Android. Pregunta por el que tienes y te confirmo."' : '  "En cualquier dispositivo con internet — PC, celular o tablet. El acceso es por Drive."'}

"quiero descuento / más barato" →
  "El precio ya está al mínimo — es lo que me permite mantener el soporte y los tutoriales. Lo que sí puedo hacer es asegurarme de que sea exactamente lo que necesitas. ¿Cuál es tu uso principal?"`;

    // ── Modo cierre (se activa después de 3 intercambios) ─────────────────────
    const modoCierre = intercambios >= 3 && productoActual ? `
🚨 MODO CIERRE — llevamos ${intercambios} mensajes intercambiados:
El cliente ya tiene suficiente información. NO hagas más preguntas de descubrimiento.
En este mensaje: valida en 1 línea lo que dijo, luego cierra directamente:
"Oye, ¿te animas? Son solo ${precio} de por vida, sin mensualidades ni nada más. Dame tu correo y te envío el acceso en segundos 🚀"
Si ya intentaste cerrar antes y no respondió → usa urgencia suave: "Los que compraron ayer ya están usando el pack. ¿Te lo envío?"` : '';

    return `Eres Cristian, asesor de ventas de AI Company CO en WhatsApp. Colombiano, 28 años, directo y cercano. Vendes productos digitales reales que le ahorran tiempo o plata al cliente.
${bloqueProducto}
PAGO: ${pago}

REGLAS ABSOLUTAS DE CONVERSACIÓN:
• Máximo 3 líneas por mensaje — nunca más
• Una sola pregunta por mensaje (si haces dos, confundes al cliente)
• Emojis solo donde añaden calidez, máximo 1-2 por mensaje
• Nunca uses "¡" en exceso — suena falso
• Si el cliente da su correo → responde CON los datos de pago de inmediato (no hagas más preguntas)
• Si el cliente manda una imagen → asume que es comprobante de pago
• Si el cliente dice "gracias, adiós" o similar → despídete cordialmente y ofrece volver cuando quiera
• Si el cliente pregunta "qué vendes" o "qué tienes" → describe brevemente los productos y pregunta qué le interesa más
• NUNCA inventes precios, links ni información que no esté en este prompt
${bloqueObjeciones}
${modoCierre}`;
}

// ── Respuesta IA ──────────────────────────────────────────────────────────────
async function respuestaIA(msg, conv, productos) {
    const productoActual = conv.producto_id ? productos.find(p => p.id === conv.producto_id) || null : null;
    const intercambios = (conv.historial || []).filter(h => h.rol === 'user').length;
    const sistema   = buildSystemPrompt(productos, productoActual, intercambios);
    const historial = (conv.historial || []).slice(-20).map(h => ({
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
// Pregunta persuasiva según producto — mantiene la conversación viva
function preguntaPersuasiva(nombreProducto) {
    const esN8n     = /n8n|agente/i.test(nombreProducto);
    const esCapcut  = /capcut/i.test(nombreProducto);

    if (esN8n) return [
        '¿Ya tienes n8n instalado o estás empezando desde cero? 🤔',
        '¿Cuántos procesos repetitivos tienes en tu negocio que quisieras automatizar? 💡',
        '¿Usas n8n para tu negocio o para aprender automatización?'
    ][Math.floor(Math.random() * 3)];

    if (esCapcut) return [
        '¿Ya editas con CapCut o estás empezando desde cero? 🎬',
        '¿Editas videos para redes sociales o para otro uso? 📱',
        '¿Cuántos videos más o menos editas a la semana?'
    ][Math.floor(Math.random() * 3)];

    if (/emula/i.test(nombreProducto)) return [
        '¿Tienes PC, celular o tablet? Así te digo cómo instalarlo 🎮',
        '¿Ya jugabas PlayStation o Xbox antes, o llevas tiempo sin jugar? 🕹️',
        '¿Cuál era tu consola favorita? PlayStation, Nintendo, Xbox...'
    ][Math.floor(Math.random() * 3)];

    return '¿Para qué lo necesitas principalmente? Así te cuento qué parte te va a servir más 😊';
}

async function enviarDetalleProducto(numero, producto) {
    const audio    = getAudioProducto(producto.nombre);
    const esN8n    = /n8n|agente/i.test(producto.nombre);
    const esEmula  = /emula/i.test(producto.nombre);

    // Emuladora: enviar video catálogo
    if (esEmula) {
        const intro = `🎮 *EmulaConsolas* — ${fmt(producto.precio)} pago único\n\n+16.000 juegos de 32 consolas. Mira el catálogo 👇`;
        await enviarTexto(numero, intro);
        await new Promise(r => setTimeout(r, 800));
        const videoPath = fs.existsSync(VIDEO_EMULADORA) ? VIDEO_EMULADORA
            : fs.existsSync(VIDEO_EMULADORA_FALLBACK) ? VIDEO_EMULADORA_FALLBACK : null;
        const videoBuffer = videoPath ? fs.readFileSync(videoPath) : null;
        if (videoBuffer) {
            await enviarVideo(numero, videoBuffer);
        } else if (process.env.VIDEO_EMULADORA_URL) {
            await enviarVideo(numero, process.env.VIDEO_EMULADORA_URL);
        }
        await new Promise(r => setTimeout(r, 1200));
        await enviarTexto(numero, preguntaPersuasiva(producto.nombre));
        return;
    }

    if (audio) {
        // 1. Intro corta
        const intro = `🔥 *${producto.nombre}* — ${fmt(producto.precio)} pago único\n\nEscucha los detalles 👇`;
        await enviarTexto(numero, intro);
        await new Promise(r => setTimeout(r, 800));

        // 2. Audio
        await enviarAudio(numero, audio);
        await new Promise(r => setTimeout(r, 1200));

        // 3. Link agentes si es n8n
        if (esN8n) {
            await enviarTexto(numero, `📋 Lista completa de los 350 agentes:\n${LINK_AGENTES_N8N}`);
            await new Promise(r => setTimeout(r, 700));
        }

        // 4. Pregunta persuasiva — no pide email todavía, primero engancha
        await enviarTexto(numero, preguntaPersuasiva(producto.nombre));
    } else {
        const msg = `🔥 *${producto.nombre}*\n💰 ${fmt(producto.precio)} — pago único de por vida\n\n${(producto.descripcion || '').slice(0, 120)}`;
        await enviarTexto(numero, msg);
        await new Promise(r => setTimeout(r, 600));
        if (esN8n) {
            await enviarTexto(numero, `📋 Lista de los 350 agentes:\n${LINK_AGENTES_N8N}`);
            await new Promise(r => setTimeout(r, 500));
        }
        await enviarTexto(numero, preguntaPersuasiva(producto.nombre));
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
    if (tipo === 'audio') {
        if (mediaBuffer) {
            await guardarHistorial(conv, 'user', '🎤 [audio]');
            const transcripcion = await transcribirAudio(mediaBuffer);
            if (transcripcion) {
                const productos   = await getProductos();
                const iaRespuesta = await respuestaIA(transcripcion, conv, productos);
                const respuesta   = iaRespuesta || '¿Me puedes escribir tu pregunta? 😊';
                await enviarTexto(numero, respuesta);
                await guardarHistorial(conv, 'bot', respuesta);
            } else {
                const r = '¿Me puedes escribir tu pregunta? 😊';
                await enviarTexto(numero, r);
                await guardarHistorial(conv, 'bot', r);
            }
        } else {
            // Audio pero no se pudo descargar (nuevo contacto, key issue)
            const r = 'Hola 👋 No pude escuchar tu nota de voz. ¿Me escribes tu consulta? 😊';
            await guardarHistorial(conv, 'user', '🎤 [audio-error]');
            await enviarTexto(numero, r);
            await guardarHistorial(conv, 'bot', r);
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

    // Sticker u otro tipo no reconocido — responder con saludo
    if (!msg) {
        if (conv.estado === 'nuevo') {
            const r = '¡Hola! 👋 ¿En qué te puedo ayudar hoy?';
            await enviarTexto(numero, r);
            await guardarHistorial(conv, 'user', '[sticker/otro]');
            await guardarHistorial(conv, 'bot', r);
            await conv.update({ estado: 'viendo_producto' });
        }
        return;
    }
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

    // ── Mención directa de producto → audio/video inmediato ─────────────────
    if (['nuevo', 'viendo_producto', 'menu'].includes(estado)) {
        const productoDetectado = detectarProductoMencionado(msgLower, productos);
        if (productoDetectado) {
            // Re-leer DB para evitar race condition con mensajes concurrentes
            const convFresh = await Conversacion.findOne({ where: { numero_wa: numero } });
            const CINCO_MIN = 5 * 60 * 1000;
            const yaViendo  = convFresh.estado === 'viendo_producto' && convFresh.producto_id === productoDetectado.id;
            const yaEnviado = (convFresh.historial || []).slice(-6).some(h =>
                h.rol === 'bot' && h.texto?.includes(productoDetectado.nombre) && (Date.now() - (h.ts || 0)) < CINCO_MIN
            );
            if (yaEnviado || yaViendo) {
                const iaRespuesta = await respuestaIA(msg, convFresh, productos);
                if (iaRespuesta) {
                    await enviarTexto(numero, iaRespuesta);
                    await guardarHistorial(convFresh, 'bot', iaRespuesta);
                }
                return;
            }
            // Guardar en DB ANTES de enviar (previene race condition: 2do msg llega durante el envío del video)
            await conv.update({ estado: 'viendo_producto', producto_id: productoDetectado.id });
            await guardarHistorial(conv, 'bot', `🔥 ${productoDetectado.nombre} — ${fmt(productoDetectado.precio)}`);
            await enviarDetalleProducto(numero, productoDetectado);
            return;
        }
    }

    // ── Primer mensaje (estado nuevo) → IA entiende el contexto ──────────────
    if (estado === 'nuevo') {
        const iaRespuesta = await respuestaIA(msg, conv, productos);
        const respuesta   = iaRespuesta || menuTexto(productos);
        await conv.update({ estado: 'viendo_producto' });
        await enviarTexto(numero, respuesta);
        await guardarHistorial(conv, 'bot', respuesta);
        return;
    }

    // ── Selección por número (solo si el número es inequívoco, 1-4 dígitos solos) ──
    const soloNumero = /^\s*[1-4]\s*$/.test(msg);
    if (soloNumero) {
        const num = parseInt(msg.trim());
        if (num >= 1 && num <= productos.length) {
            const producto = productos[num - 1];
            await conv.update({ estado: 'viendo_producto', producto_id: producto.id });
            await guardarHistorial(conv, 'bot', `🔥 ${producto.nombre} — ${fmt(producto.precio)}`);
            await enviarDetalleProducto(numero, producto);
            return;
        }
    }

    // ── "Ya pagué" sin comprobante ────────────────────────────────────────────
    if (/ya pagu[eé]|realic[eé] el pago|hice la transferencia|mand[eé] el pago/i.test(msgLower)) {
        const r = '¡Listo! Mándame la captura del comprobante (Nequi, Daviplata, etc.) y en segundos te envío el acceso ⚡';
        await enviarTexto(numero, r);
        await guardarHistorial(conv, 'bot', r);
        if (conv.estado !== 'esperando_comprobante' && conv.producto_id) {
            await conv.update({ estado: 'esperando_comprobante' });
        }
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

    // ── Email sin producto (cliente listo para comprar pero sin producto asignado) ──
    if (emailMatch && !conv.producto_id) {
        const iaRespuesta = await respuestaIA(`El cliente dio su correo (${emailMatch[0]}) pero aún no eligió producto. Pregúntale qué producto quiere comprar.`, conv, productos);
        if (iaRespuesta) {
            await enviarTexto(numero, iaRespuesta);
            await guardarHistorial(conv, 'bot', iaRespuesta);
        }
        return;
    }

    // ── Prueba social: enviar comprobante cuando dudan de la legitimidad ────────
    if (/legítimo|legitimo|real|estafa|seguro|confiar|prueba|evidencia|comprobante.*otros|pagaron|otros clientes|funciona.*real|es verdad|mentira/i.test(msgLower)) {
        const buffer = getComprobante();
        if (buffer) {
            await enviarTexto(numero, 'Mira, acá te muestro uno de los pagos recientes de otros clientes 👇');
            await new Promise(r => setTimeout(r, 500));
            const { getClient } = require('./whatsappClient');
            const sock = getClient();
            const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
            if (sock) await sock.sendMessage(jid, { image: buffer, caption: '✅ Comprobante de pago real — llevamos cientos de compradores satisfechos 🙌' });
            await new Promise(r => setTimeout(r, 800));
            const cierre = `¿Cuál es tu duda principal? Te la resuelvo ahora mismo 😊`;
            await enviarTexto(numero, cierre);
            await guardarHistorial(conv, 'bot', '[comprobante enviado] ' + cierre);
        } else {
            const iaRespuesta = await respuestaIA(msg, conv, productos);
            if (iaRespuesta) { await enviarTexto(numero, iaRespuesta); await guardarHistorial(conv, 'bot', iaRespuesta); }
        }
        return;
    }

    // ── Si pregunta por la lista de agentes n8n, dar el link directo ────────────
    if (/agentes?|lista|cuáles|cuales|qué agentes|que agentes|350/i.test(msgLower) && /n8n/i.test(msgLower + (conv.ultimo_mensaje || ''))) {
        const respuesta = `📋 Aquí está la lista completa de los 350 agentes:\n${LINK_AGENTES_N8N}\n\n¿Cuál es el que más te llama la atención? 👀`;
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
        // Detectar intención de compra real para cambiar estado a esperando_email
        const quiereComprar = /correo|email|pagar|lo quiero|me lo llevo|cómo compro|cómo pago|lo pido|dale|listo/i.test(iaRespuesta);
        if (quiereComprar && conv.producto_id) updateData.estado = 'esperando_email';
        const mencionaPago = /nequi|daviplata|comprobante|transferencia|bre-b/i.test(iaRespuesta);
        if (mencionaPago && conv.producto_id) updateData.estado = 'esperando_comprobante';
        if (!conv.estado || conv.estado === 'nuevo') updateData.estado = 'viendo_producto';
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
