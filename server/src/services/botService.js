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
// productoActual: si la conversación ya tiene un producto, las palabras genéricas
// ("combo", "completo", "premium", "curso") NO deben saltar a otra familia de producto.
function detectarProductoMencionado(msgLower, productos, productoActual = null) {
    const familiaActual = productoActual
        ? (/n8n|agente/i.test(productoActual.nombre) ? 'n8n'
            : /capcut|combo/i.test(productoActual.nombre) ? 'capcut'
            : /emula/i.test(productoActual.nombre) ? 'emula' : null)
        : null;

    // Si ya está en familia n8n y pide "completo/premium/combo/todo/curso" → n8n Premium (no el Combo CapCut)
    if (familiaActual === 'n8n' && /premium|completo|combo|todo|con curso|el curso|hosting|nube/i.test(msgLower)) {
        const prem = productos.find(p => /n8n/i.test(p.nombre) && /premium/i.test(p.nombre));
        if (prem) return prem;
    }
    // Si ya está en familia capcut y pide "completo/combo/recursos" → Combo CapCut
    if (familiaActual === 'capcut' && /combo|completo|recursos|vectores|plantillas|todo/i.test(msgLower)) {
        const combo = productos.find(p => /combo/i.test(p.nombre));
        if (combo) return combo;
    }

    for (const p of productos) {
        const n = p.nombre.toLowerCase();
        // Mención explícita de n8n/agentes tiene prioridad sobre "combo" genérico
        if (n.includes('n8n') && n.includes('premium') && (msgLower.includes('premium') || msgLower.includes('hosting') || msgLower.includes('nube'))) return p;
        if ((n.includes('n8n') || n.includes('agente')) && !n.includes('premium') && (msgLower.includes('n8n') || msgLower.includes('agente'))) return p;
        // Combo CapCut: solo si hay contexto de video/edición, no para leads de n8n
        if (n.includes('combo') && (msgLower.includes('combo') || msgLower.includes('recursos') || msgLower.includes('vectores')) && !/n8n|agente|automatiz/i.test(msgLower)) return p;
        if (n.includes('capcut') && !n.includes('combo') && (msgLower.includes('capcut') || msgLower.includes('edici') || msgLower.includes('video'))) return p;
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

// ── Sistema prompt natural — suena como persona real, no como robot ────────────
function buildSystemPrompt(productos, productoActual = null, intercambios = 0) {
    const nequi     = process.env.NEQUI_NUMERO     || '';
    const daviplata = process.env.DAVIPLATA_NUMERO || '';
    const llave     = process.env.LLAVE_NUMERO     || '';
    const pagNombre = process.env.PAGO_NOMBRE      || '';
    const pago      = `Nequi ${nequi}${daviplata ? ' / Daviplata ' + daviplata : ''}${llave ? ' / Bre-b ' + llave : ''}${pagNombre ? ' — ' + pagNombre : ''}`;

    const esCapcut     = productoActual && /capcut/i.test(productoActual.nombre) && !/combo/i.test(productoActual.nombre);
    const esN8n        = productoActual && /n8n|agente/i.test(productoActual.nombre) && !/premium/i.test(productoActual.nombre);
    const esN8nPremium = productoActual && /n8n/i.test(productoActual.nombre) && /premium/i.test(productoActual.nombre);
    const esEmula      = productoActual && /emula/i.test(productoActual.nombre);
    const precio       = productoActual ? fmt(productoActual.precio) : '';

    // Detectar si el cliente ya rechazó el combo/premium (aparece en historial)
    const historialTexto = ''; // se evalúa en runtime via conv.historial, aquí solo es la plantilla

    // Bloque de producto — estrategia: primero ofrece el de mayor valor, si no acepta baja al básico
    let infoProducto = '';
    if (productoActual) {
        if (esN8n || esN8nPremium) {
            infoProducto = `
El cliente preguntó por automatizaciones n8n.

ESTRATEGIA DE VENTA (síguela en orden):
1. Primero ofrece el Pack Premium ${fmt(35000)}: 350 agentes + curso completo desde cero + n8n instalado en la nube gratis. Es la opción completa para quien quiere aprender y automatizar.
2. Si el cliente ya sabe usar n8n o dice que solo quiere los agentes → ofrece el Pack Básico ${fmt(20000)}: 350 agentes listos para importar, sin curso.
3. Si el cliente duda del precio del Premium → muéstrale el valor: "Por ${fmt(35000)} tienes el curso + los agentes + n8n en la nube. Si lo hicieras por tu cuenta solo el hosting ya te sale más. ¿Empiezas desde cero o ya manejas n8n?"

Nunca ofrezcas los dos al mismo tiempo sin antes saber qué necesita. Primero haz la pregunta de descubrimiento, luego recomienda.

No hables de CapCut ni otros productos. Solo n8n.`;
        } else if (esCapcut) {
            infoProducto = `
El cliente preguntó por edición de video.

ESTRATEGIA DE VENTA (síguela en orden):
1. Primero ofrece el Combo CapCut + Pack de Recursos ${fmt(35000)}: 3 cursos completos (CapCut PRO + Edición Profesional + Photoshop PRO) + pack de vectores, efectos y plantillas listas. Todo de por vida. Ahorran ${fmt(15000)} vs comprarlo por separado.
2. Si el cliente dice que es mucho, que solo quiere el curso, o que tiene presupuesto limitado → cierra con el curso solo: ${fmt(20000)} de por vida (CapCut PRO + Edición + Photoshop).
3. Nunca bajes al básico sin antes intentar cerrar el combo al menos una vez.

Para enganchar: pregúntale para qué plataforma edita (TikTok, Reels, YouTube) o si edita para un negocio. Eso te da el gancho.`;
        } else if (esEmula) {
            infoProducto = `
El cliente preguntó por la emuladora. ${precio} de por vida — +16.000 juegos de 32 consolas: PS1, PS2, PS3, Xbox, Xbox 360, Nintendo, N64, GBA y más. Funciona en PC, tablet o celular Android.
Juegos top: God of War, GTA, FIFA, Call of Duty, Mario, Zelda, Sonic.

No hay combo para este producto. Cierra directo en ${precio}. El gancho es preguntarle qué consola le gustaba o qué dispositivo tiene.`;
        } else if (/combo/i.test(productoActual.nombre)) {
            infoProducto = `
El cliente está viendo el combo CapCut + Pack de Recursos. ${precio} de por vida — 3 cursos de edición + vectores, efectos y plantillas. Es el mayor valor. Cierra aquí, no bajes al básico a menos que el cliente pida expresamente la opción más económica.`;
        } else if (/premium/i.test(productoActual.nombre)) {
            infoProducto = `
El cliente está viendo el Pack n8n Premium. ${precio} de por vida — 350 agentes + curso desde cero + n8n en la nube gratis. Es el mayor valor. Cierra aquí. Solo ofrece el básico si el cliente dice explícitamente que ya sabe usar n8n y no necesita el curso.`;
        } else {
            infoProducto = `Producto: ${productoActual.nombre} — ${precio} de por vida.`;
        }
    }

    // Fase de cierre — a partir del 3er intercambio deja de explorar y empuja al pago
    const faseCierre = intercambios >= 3 && productoActual ? `
⚡ FASE DE CIERRE (ya llevan varios mensajes): deja de hacer preguntas exploratorias. Resume el beneficio principal en 1 línea, recuérdale que es pago único de por vida, y pide el correo con cierre asumido: "Dame tu correo y te dejo todo listo en segundos 🚀". Si pone una objeción, resuélvela en 1 línea y vuelve a pedir el correo. No lo dejes enfriar.` : '';

    return `Eres Cristian, vendedor PROFESIONAL de productos digitales por WhatsApp. Colombiano, 28 años, cálido y seguro. Vendes como los mejores: escuchas, conectas, y cierras. Hablas como una persona real, nunca como folleto.

${productoActual
    ? `Estás hablando con alguien interesado en: ${productoActual.nombre}\nNo cambies de producto ni menciones otros durante esta conversación.${infoProducto}`
    : 'Aún no sabes qué busca el cliente. Haz UNA pregunta para descubrir qué necesita y guíalo al producto que le sirve.'}

Pago: ${pago}

🚫 REGLAS QUE NUNCA PUEDES ROMPER (lo más importante):
1. ERES CRISTIAN, UNA PERSONA REAL. Jamás digas que eres bot, IA o que esto es automatizado. Si preguntan "¿es automático?" / "¿eres un robot?": "No, soy Cristian 😄 a veces me demoro porque atiendo a varios, pero soy yo".
2. TÚ NO ENTREGAS NADA POR TU CUENTA. El acceso lo entrega el sistema SOLO cuando el cliente manda la FOTO del pago. Nunca digas "ya te envié", "ya quedó enviado", "revisa tu correo". Eso es mentira y mata la confianza.
3. Si dice que ya pagó pero no manda foto → "Perfecto 🙌 mándame la captura del pago y al toque te llega el acceso". Nunca asumas el pago sin ver la foto.
4. NO PROMETAS demos, videos ni pruebas en vivo — no existen. Si piden ver funcionando: "No manejo demos en video, pero llevamos cientos de compradores contentos. Es ${precio || '$20.000'} una sola vez, riesgo mínimo. ¿Le entramos?".

🎯 TU MÉTODO DE VENTA (síguelo siempre):
1. DESCUBRE (1 pregunta): antes de vender, entiende para qué lo quiere. Eso te da el gancho para venderle el RESULTADO que busca, no el producto.
2. VENDE LA TRANSFORMACIÓN, no las características: no digas "trae 350 agentes", di "automatizas tu negocio y te ahorras horas todos los días". Conecta el producto con lo que el cliente te dijo que necesita.
3. ANCLA EL VALOR antes del precio: menciona todo lo que incluye y lo que costaría por separado, ASÍ el precio suena a ganga. "Todo esto por solo ${precio || '$20.000'}, una vez y de por vida".
4. PRUEBA SOCIAL: "llevamos cientos de compradores", "la mayoría arranca el mismo día". Genera confianza sin que te la pidan.
5. CIERRE ASUMIDO: no preguntes "¿te interesa?". Da por hecho que sí y avanza: "Dame tu correo y te lo dejo listo 🚀". Es más fácil decir sí cuando el siguiente paso es pequeño.
6. URGENCIA HONESTA: dale una razón para hoy — "te lo activo ya mismo", "arrancas hoy y no lo dejas para nunca". Nunca inventes descuentos ni fechas falsas.
7. UNA SOLA PREGUNTA por mensaje. Máximo 3 líneas. Lleva siempre la conversación hacia el correo y el pago.

💬 Estilo:
— Mensajes cortos de WhatsApp, cálidos, sin exceso de signos de exclamación.
— Si te dan el correo, responde solo con los datos de pago — nada más.
— No interrogues eternamente: máximo 2 preguntas de calentamiento, luego pide el correo.
— Nunca inventes precios, links ni garantías que no estén aquí.

🛡️ Manejo de objeciones (empatiza → reencuadra → recierra, en 2-3 líneas):
— "está caro": "Te entiendo. Pero piénsalo: es un pago único, no mensualidad. Una sola suscripción al mes te cuesta más, y esto es tuyo de por vida. ¿Te lo dejo listo?"
— "lo pienso / después": "Claro. ¿Qué es lo único que te frena? Te lo aclaro ya y decides tranquilo."
— "¿es legal/confiable?": "Totalmente, son productos propios y llevamos cientos de compradores sin un solo problema. ¿Le entramos?"
— "no tengo plata ahorita": "Sin afán 😊 ¿Para cuándo crees que podrías? Te lo reservo y te escribo ese día."
— "¿está gratis en YouTube?": "Disperso sí, pero te tomaría semanas armar la ruta. Aquí lo tienes ordenado y listo por ${precio || '$20.000'}. Vale más tu tiempo."
— "quiero ver ejemplo/demo": (regla 4) valor + prueba social + recierre. Nunca prometas un demo.
— "pago contra entrega": "Es un producto digital, llega al instante por aquí apenas confirmas el pago — no hay envío físico. ¿Te paso los datos?"
— "quiero descuento": "El precio ya está al mínimo por todo lo que llevas. Lo que sí hago es asegurarme de que te sirva 100%. ¿Para qué lo vas a usar?"
${faseCierre}`;
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
    const esCombo  = /combo/i.test(producto.nombre);
    const esPremium = /premium/i.test(producto.nombre);

    // Emuladora: 1 video con caption + 1 pregunta (2 mensajes en total)
    if (esEmula) {
        const videoPath = fs.existsSync(VIDEO_EMULADORA) ? VIDEO_EMULADORA
            : fs.existsSync(VIDEO_EMULADORA_FALLBACK) ? VIDEO_EMULADORA_FALLBACK : null;
        const videoBuffer = videoPath ? fs.readFileSync(videoPath) : null;
        const caption = `🎮 *EmulaConsolas* — ${fmt(producto.precio)} de por vida\n+16.000 juegos: PS1, PS2, PS3, Xbox, Nintendo, GBA y más 🕹️`;
        if (videoBuffer) {
            await enviarVideo(numero, videoBuffer, caption);
        } else if (process.env.VIDEO_EMULADORA_URL) {
            await enviarVideo(numero, process.env.VIDEO_EMULADORA_URL, caption);
        } else {
            await enviarTexto(numero, caption);
        }
        await new Promise(r => setTimeout(r, 1000));
        await enviarTexto(numero, preguntaPersuasiva(producto.nombre));
        return;
    }

    if (audio) {
        await enviarAudio(numero, audio);
        await new Promise(r => setTimeout(r, 1000));

        let texto = `💰 *${fmt(producto.precio)}* de por vida — sin mensualidades`;
        if (esCombo) {
            texto += `\n\n🔥 *Combo completo:* CapCut PRO + Edición Profesional + Photoshop PRO + pack de vectores, efectos y plantillas. Todo incluido, ahorras *${fmt(15000)}* vs comprarlo por separado.`;
        } else if (esPremium && esN8n) {
            texto += `\n\n⭐ *Pack completo:* 350 agentes listos + curso n8n desde cero hasta avanzado + te instalamos n8n en la nube GRATIS ☁️\n📋 Los 350 agentes:\n${LINK_AGENTES_N8N}`;
        } else if (esN8n) {
            texto += `\n\n📋 Los 350 agentes:\n${LINK_AGENTES_N8N}`;
        }
        texto += `\n\n${preguntaPersuasiva(producto.nombre)}`;
        await enviarTexto(numero, texto);
    } else {
        // Sin audio: descripción + pregunta en 2 mensajes
        const desc = (producto.descripcion || '').slice(0, 100);
        const msg = `🔥 *${producto.nombre}* — ${fmt(producto.precio)} de por vida${desc ? '\n\n' + desc : ''}`;
        await enviarTexto(numero, msg);
        await new Promise(r => setTimeout(r, 600));
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

    // Imagen que NO se pudo descargar (contacto @lid / problema de keys) — no perder la venta
    if (tipo === 'image' && !mediaBuffer) {
        await guardarHistorial(conv, 'user', '🖼️ [imagen no descargada]');
        if (['esperando_comprobante', 'esperando_email'].includes(conv.estado) || conv.producto_id) {
            const producto = conv.producto_id ? await Producto.findByPk(conv.producto_id) : null;
            await notificarTelegram(`⚠️ *Comprobante por verificar manualmente*\n👤 ${conv.nombre_cliente || numero}\n📱 ${numero}\n📦 ${producto?.nombre || 'sin producto'}\n💰 ${producto ? fmt(producto.precio) : '—'}\n📧 ${conv.email_cliente || '—'}\n\nNo pude descargar la imagen automáticamente. Revisa el chat y entrega el acceso si el pago es válido.`);
            const r = 'Recibí tu imagen 🙌 dame un momentico que verifico el pago y te activo el acceso. ¿Me confirmas tu correo para enviártelo?';
            await enviarTexto(numero, r);
            await guardarHistorial(conv, 'bot', r);
        } else {
            const r = 'Vi que me mandaste una imagen pero no me cargó bien 🤔 ¿Me cuentas qué producto te interesa y te ayudo?';
            await enviarTexto(numero, r);
            await guardarHistorial(conv, 'bot', r);
        }
        return;
    }

    // Sticker / saludo automático de anuncio Meta — mostrar menú directo
    if (!msg) {
        if (conv.estado === 'nuevo') {
            const productosMenu = await getProductos();
            await guardarHistorial(conv, 'user', '[sticker/otro]');
            const bienvenida = `Hola 👋 ¿Cuál de estos te interesa?`;
            const menu = menuTexto(productosMenu);
            await enviarTexto(numero, bienvenida);
            await new Promise(r => setTimeout(r, 600));
            await enviarTexto(numero, menu);
            await guardarHistorial(conv, 'bot', `${bienvenida}\n${menu}`);
            await conv.update({ estado: 'menu' });
        }
        return;
    }
    await guardarHistorial(conv, 'user', msg);

    const productos = await getProductos();

    // ── Cliente molesto / pide que no le escriban → frenar followups y responder corto ──
    if (/deja de (escribir|enviar|mandar)|no me escrib|no me interesa ya|no escrib|me dejas de|mensajes excesivos|para de escribir|no quiero m[aá]s mensaje/i.test(msgLower)) {
        await conv.update({ notas: { ...(conv.notas || {}), no_followup: true } });
        const r = 'Listo, no te escribo más 🙌 Si algún día lo necesitas, aquí estoy. ¡Un abrazo!';
        await enviarTexto(numero, r);
        await guardarHistorial(conv, 'bot', r);
        return;
    }

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
        const productoActualConv = conv.producto_id ? productos.find(p => p.id === conv.producto_id) || null : null;
        let productoDetectado = detectarProductoMencionado(msgLower, productos, productoActualConv);
        if (productoDetectado) {
            // Upsell automático: redirigir al de mayor valor, salvo que el cliente pida el básico
            // o diga que YA sabe usar n8n (entonces no le sirve el curso → básico $20k)
            const quiereBasico = /b[aá]sico|solo el curso|solo los agentes|solo los? agente|economico|econ[oó]mico|barato|m[aá]s barato|m[aá]s econ|ya manejo|ya s[eé] usar|ya lo tengo|ya lo manejo|ya uso n8n|s[eé] usar n8n/i.test(msgLower);
            if (!quiereBasico) {
                if (/capcut/i.test(productoDetectado.nombre) && !/combo/i.test(productoDetectado.nombre)) {
                    const combo = productos.find(p => /combo/i.test(p.nombre));
                    if (combo) productoDetectado = combo;
                } else if (/n8n|agente/i.test(productoDetectado.nombre) && !/premium/i.test(productoDetectado.nombre)) {
                    const premium = productos.find(p => /premium/i.test(p.nombre) && /n8n/i.test(p.nombre));
                    if (premium) productoDetectado = premium;
                }
            }
            // Re-leer DB para evitar race condition con mensajes concurrentes
            const convFresh = await Conversacion.findOne({ where: { numero_wa: numero } });
            const CINCO_MIN = 5 * 60 * 1000;
            const yaViendo  = convFresh.estado === 'viendo_producto' && convFresh.producto_id === productoDetectado.id;
            // Solo el marcador específico del detalle (🔥 ...) evita falso positivo con el menú,
            // que también contiene los nombres de los productos
            const markerDetalle = `🔥 ${productoDetectado.nombre}`;
            const yaEnviado = (convFresh.historial || []).slice(-6).some(h =>
                h.rol === 'bot' && h.texto?.startsWith(markerDetalle) && (Date.now() - (h.ts || 0)) < CINCO_MIN
            );
            if (yaEnviado || yaViendo) {
                const iaRespuesta = await respuestaIA(msg, convFresh, productos);
                const respuesta = iaRespuesta || preguntaPersuasiva(productoDetectado.nombre);
                await enviarTexto(numero, respuesta);
                await guardarHistorial(convFresh, 'bot', respuesta);
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
    // Frases explícitas de pago (en cualquier estado)
    const dicePagoExplicito = /ya pagu[eé]|realic[eé] el pago|hice la transferencia|mand[eé] el pago|transfer[ií]|ya consign[eé]|ya envi[eé] el pago/i.test(msgLower);
    // Frases ambiguas de "ya terminé" — solo cuentan si va camino al pago (esperando comprobante/email o ya dio correo)
    const enFlujoPago = ['esperando_comprobante', 'esperando_email'].includes(conv.estado) || conv.email_cliente;
    const diceListoAmbiguo = enFlujoPago && /^(listo|ya est[aá]|ya qued[oó]|ya hice|ya esta echo|ya está hecho|hecho|ya|ya aqui|aqui esta|ahi esta|ahi va|ya envi[eé])\b/i.test(msgLower);
    if (dicePagoExplicito || diceListoAmbiguo) {
        const r = 'Perfecto 🙌 Para activarte el acceso necesito ver la *captura o foto del pago*. Mándamela por aquí y en segundos te llega todo ⚡';
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
