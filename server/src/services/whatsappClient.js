const path = require('path');
const fs   = require('fs');
const QRCode = require('qrcode');

let sock = null;
let qrData = null;
let status = 'disconnected';
let preKeysReady = false;
const msgQueue = [];

// Alerta Telegram para eventos críticos del bot
async function alertarTelegram(mensaje) {
    const token  = process.env.PLATAFORMA_TELEGRAM_TOKEN;
    const chatId = process.env.PLATAFORMA_TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: mensaje, parse_mode: 'Markdown' })
        });
    } catch {}
}

// Deduplicación: evita procesar el mismo mensaje dos veces (Baileys a veces lo emite doble)
const processedIds = new Set();

// Último mensaje completo recibido por JID — para respuestas citadas
const lastMsg = new Map();

// Cache LID → JID de teléfono
const lidCache = {};

function detectAuthFolder() {
    // Usar directamente el env var — Railway lo setea al mount path del volumen (/app/wa_auth)
    const envFolder = process.env.WA_AUTH_FOLDER;
    if (envFolder) {
        fs.mkdirSync(envFolder, { recursive: true });
        console.log('📁 Auth folder:', envFolder);
        return envFolder;
    }
    const fallback = path.join(process.cwd(), 'wa_auth');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
}

const AUTH_FOLDER = detectAuthFolder();
const LID_CACHE_FILE = path.join(AUTH_FOLDER, 'lid_cache.json');

function loadLidCache() {
    try {
        if (fs.existsSync(LID_CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(LID_CACHE_FILE, 'utf-8'));
            Object.assign(lidCache, data);
            console.log(`📞 Cache LID: ${Object.keys(lidCache).length} contactos`);
        }
    } catch {}
}

function saveLidCache() {
    try {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        fs.writeFileSync(LID_CACHE_FILE, JSON.stringify(lidCache));
    } catch {}
}

function resolveLid(jid) {
    if (!jid || !jid.endsWith('@lid')) return jid;
    const resolved = lidCache[jid];
    if (resolved) {
        console.log(`📞 LID resuelto: ${jid} → ${resolved}`);
        return resolved;
    }
    return jid;
}

// Mensaje completo recibido por JID — para quoted reply
function getLastMsg(jid) {
    return lastMsg.get(jid) || null;
}

// Busca recursivamente el primer texto significativo en un mensaje (rescata CTWA raros)
function buscarTextoProfundo(obj, prof = 0) {
    if (!obj || typeof obj !== 'object' || prof > 6) return '';
    const campos = ['conversation','text','title','body','caption','selectedDisplayText','name','description'];
    for (const k of campos) {
        if (typeof obj[k] === 'string' && obj[k].trim().length > 2) return obj[k].trim();
    }
    for (const k in obj) {
        if (obj[k] && typeof obj[k] === 'object') {
            const r = buscarTextoProfundo(obj[k], prof + 1);
            if (r) return r;
        }
    }
    return '';
}

loadLidCache();

function getClient() { return sock; }
function getQR()     { return qrData; }
function getStatus() { return status; }

function limpiarCredenciales() {
    try {
        if (fs.existsSync(AUTH_FOLDER)) {
            fs.readdirSync(AUTH_FOLDER).forEach(f => {
                try { fs.unlinkSync(path.join(AUTH_FOLDER, f)); } catch {}
            });
        }
        console.log('🗑️  Credenciales WA eliminadas — se generará nuevo QR');
    } catch (e) {
        console.error('Error limpiando credenciales:', e.message);
    }
}

async function resetAndRestart() {
    status = 'disconnected';
    qrData = null;
    if (sock) { try { await sock.logout(); } catch {} sock = null; }
    limpiarCredenciales();
    await new Promise(r => setTimeout(r, 1500));
    await iniciar();
}

async function iniciar() {
    let baileys;
    try {
        baileys = require('@whiskeysockets/baileys');
    } catch (e) {
        console.error('Baileys no instalado:', e.message);
        return;
    }

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
            downloadMediaMessage, Browsers, fetchLatestBaileysVersion,
            makeInMemoryStore, makeCacheableSignalKeyStore } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    // v7 requiere fetchLatestBaileysVersion para que use el bridge de Rust correcto
    const { version } = await fetchLatestBaileysVersion();
    console.log('📱 Baileys v7 — versión WA:', version.join('.'));

    // Store en memoria para manejo automático de contactos/chats
    const store = makeInMemoryStore ? makeInMemoryStore({}) : null;

    // msgRetryCounterCache para manejo correcto de reintentos (requerido en v7)
    const { LRUCache } = require('lru-cache');
    const msgRetryCounterCache = new LRUCache({ max: 100 });

    sock = makeWASocket({
        version,
        // v7: usar makeCacheableSignalKeyStore para Signal Protocol correcto con @lid
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore
                ? makeCacheableSignalKeyStore(state.keys, require('pino')({ level: 'silent' }))
                : state.keys,
        },
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: true,
        msgRetryCounterCache,
        getMessage: async () => undefined,
    });

    // saveCreds guardado en variable para poder removerlo antes de limpiar creds
    const onCredsUpdate = saveCreds;
    sock.ev.on('creds.update', onCredsUpdate);

    // Bind store al socket — gestiona contactos, chats y mensajes automáticamente
    if (store) store.bind(sock.ev);

    // Construir cache LID → teléfono desde sync de historial y contactos
    function procesarContactos(contacts, fuente) {
        let updated = 0;
        for (const c of contacts) {
            // Caso 1: c.id es @s.whatsapp.net y c.lid es el @lid
            if (c.lid && c.id && c.id.endsWith('@s.whatsapp.net')) {
                lidCache[c.lid] = c.id;
                updated++;
            }
            // Caso 2: c.id es @lid — registrar también por si contacts.upsert usa id=@lid
            if (c.id && c.id.endsWith('@lid') && c.phoneNumber) {
                const phoneJid = `${c.phoneNumber}@s.whatsapp.net`;
                lidCache[c.id] = phoneJid;
                updated++;
            }
        }
        if (updated > 0) {
            console.log(`📞 [${fuente}] Cache LID: +${updated} mapeados (total ${Object.keys(lidCache).length})`);
            saveLidCache();
        }
    }

    sock.ev.on('contacts.upsert', (contacts) => {
        if (contacts.length > 0) {
            // Log primeros 2 contactos para diagnóstico
            console.log('📋 contacts.upsert muestra:', JSON.stringify(contacts.slice(0,2)));
        }
        procesarContactos(contacts, 'contacts.upsert');
    });

    sock.ev.on('contacts.update', (updates) => procesarContactos(updates, 'contacts.update'));

    // Historia de mensajes — puede traer JIDs @s.whatsapp.net de chats anteriores
    sock.ev.on('messaging-history.set', ({ contacts = [], chats = [] }) => {
        console.log(`📚 History sync: ${contacts.length} contactos, ${chats.length} chats`);
        if (contacts.length > 0) {
            console.log('📋 History contacts muestra:', JSON.stringify(contacts.slice(0,2)));
        }
        procesarContactos(contacts, 'history-sync');
        // Los chats también pueden tener info del JID real
        let chatUpdated = 0;
        for (const chat of chats) {
            if (chat.id?.endsWith('@s.whatsapp.net') && chat.lidJid) {
                lidCache[chat.lidJid] = chat.id;
                chatUpdated++;
            }
        }
        if (chatUpdated > 0) {
            console.log(`📞 [history-chats] Cache LID: +${chatUpdated} mapeados`);
            saveLidCache();
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrData = qr;
            status = 'qr';
            console.log('📱 QR generado — escanea desde el panel admin');
            alertarTelegram('📱 *WhatsApp Bot — QR requerido*\nEl bot necesita que escanees el QR.\nEntra al panel admin y escanea para reconectar.');
        }

        if (connection === 'close') {
            status = 'disconnected';
            qrData = null;
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            console.log('WhatsApp desconectado, código:', code);
            if (loggedOut) {
                alertarTelegram('🔴 *WhatsApp Bot DESCONECTADO — Sesión revocada*\nAlguien cerró la sesión desde el celular. Entra al panel y escanea el QR para reconectar.');
                console.log('Sesión revocada — limpiando credenciales...');
                try { sock.ev.removeAllListeners('creds.update'); } catch {}
                limpiarCredenciales();
                setTimeout(() => {
                    limpiarCredenciales();
                    iniciar();
                }, 300);
            } else {
                alertarTelegram(`⚠️ *WhatsApp Bot desconectado* (código ${code})\nReconectando en 5 segundos automáticamente...`);
                console.log('Reconectando en 5 segundos...');
                setTimeout(iniciar, 5000);
            }
        }

        if (connection === 'open') {
            status = 'ready';
            qrData = null;
            preKeysReady = false;
            console.log('✅ WhatsApp conectado — esperando 30s para pre-keys...');
            alertarTelegram('✅ *WhatsApp Bot conectado y operativo*\nEl bot está respondiendo mensajes normalmente.');
            setTimeout(async () => {
                preKeysReady = true;
                console.log(`✅ Bot operativo — cache LID: ${Object.keys(lidCache).length} contactos`);
                if (msgQueue.length > 0) {
                    console.log(`📨 Procesando ${msgQueue.length} mensajes en cola...`);
                    for (const data of msgQueue) {
                        try { const { procesarMensaje } = require('./botService'); await procesarMensaje(data); }
                        catch (e) { console.error('Error procesando cola:', e.message); }
                    }
                    msgQueue.length = 0;
                }
                // Disparar seguimientos al reconectar — recupera leads que pudieron perderse durante el deploy
                try {
                    const { ejecutarSeguimientos } = require('./followUpService');
                    await ejecutarSeguimientos();
                    console.log('✅ Seguimientos post-reconexión ejecutados');
                } catch (e) { console.error('Error seguimientos post-reconexión:', e.message); }
            }, 30000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Procesar 'notify' (mensajes nuevos) y 'append' recientes (CTWA de anuncios Meta)
        // 'append' = mensajes sincronizados; solo procesar si son muy recientes (< 3 min) para no re-procesar historial viejo
        const ahora = Date.now();
        const procesables = type === 'notify' ? messages : messages.filter(m => {
            if (m.key.fromMe) return false;
            const jid = m.key.remoteJid || '';
            if (jid.includes('@g.us') || jid === 'status@broadcast') return false;
            // Solo mensajes de los últimos 3 minutos
            const msgTs = (m.messageTimestamp || 0) * 1000;
            const reciente = (ahora - msgTs) < 3 * 60 * 1000;
            if (reciente) console.log(`📩 [${type}] CTWA reciente procesado: ${jid}`);
            else console.log(`📩 [${type}] histórico ignorado: ${jid}`);
            return reciente;
        });
        if (procesables.length === 0) return;
        for (const msg of procesables) {
            if (msg.key.fromMe) continue;
            const jid = msg.key.remoteJid || '';
            if (jid.includes('@g.us') || jid === 'status@broadcast') continue;
            console.log(`📨 Mensaje entrante: ${jid} tipo=${Object.keys(msg.message || {}).join('|') || 'vacío'}`);

            // Ignorar mensajes ya procesados (Baileys a veces emite duplicados)
            const msgId = msg.key.id;
            if (msgId && processedIds.has(msgId)) {
                console.log('⚠️ Duplicado ignorado:', msgId);
                continue;
            }
            if (msgId) {
                processedIds.add(msgId);
                if (processedIds.size > 500) {
                    const iter = processedIds.values();
                    for (let i = 0; i < 100; i++) processedIds.delete(iter.next().value);
                }
            }

            // Guardar mensaje completo para quoted reply y resolución de LID desde store
            lastMsg.set(jid, msg);

            // Intentar resolver @lid desde el store de contactos
            if (jid.endsWith('@lid') && store) {
                const contacts = store.contacts || {};
                for (const [phoneJid, contact] of Object.entries(contacts)) {
                    if (phoneJid.endsWith('@s.whatsapp.net') &&
                        (contact.lid === jid || contact.id === jid)) {
                        if (!lidCache[jid]) {
                            lidCache[jid] = phoneJid;
                            console.log(`📞 [store] LID resuelto: ${jid} → ${phoneJid}`);
                            saveLidCache();
                        }
                        break;
                    }
                }
            }

            try {
                const numero = jid;
                const nombre = msg.pushName || '';

                let tipo = 'text';
                // Extraer texto de todos los formatos posibles, incluyendo mensajes de anuncios IG/FB
                const m = msg.message || {};
                let texto = m.conversation
                    || m.extendedTextMessage?.text
                    || m.buttonsResponseMessage?.selectedDisplayText
                    || m.listResponseMessage?.title
                    || m.templateButtonReplyMessage?.selectedDisplayText
                    || m.interactiveResponseMessage?.body?.text
                    || m.interactiveMessage?.body?.text
                    || m.nativeFlowResponseMessage?.name
                    || m.ephemeralMessage?.message?.conversation
                    || m.ephemeralMessage?.message?.extendedTextMessage?.text
                    || m.viewOnceMessage?.message?.conversation
                    || '';

                // Mensajes de anuncio Meta (CTWA - Click to WhatsApp Ads)
                // Formato 1: extendedTextMessage con contextInfo del anuncio
                if (!texto && m.extendedTextMessage) {
                    texto = m.extendedTextMessage.text || '';
                }
                // Formato 2: contextInfo con texto del botón del anuncio
                if (!texto) {
                    const ctx = m.extendedTextMessage?.contextInfo
                        || m.interactiveResponseMessage?.contextInfo
                        || m.buttonsResponseMessage?.contextInfo;
                    if (ctx) {
                        texto = ctx.forwardedNewsletterMessageInfo?.newsletterName
                            || ctx.quotedMessage?.conversation
                            || ctx.quotedMessage?.extendedTextMessage?.text
                            || '';
                    }
                }
                // Formato 3: TÍTULO/BODY del propio anuncio (externalAdReply) — TRAE EL PRODUCTO
                // Ej: "MAS INFORMACION DE LA EMULADORA DE JUEGOS" / "...PAQUETE DE N8N" / "...curso de capcut"
                if (!texto) {
                    const ad = m.extendedTextMessage?.contextInfo?.externalAdReply
                        || m.imageMessage?.contextInfo?.externalAdReply
                        || m.contextInfo?.externalAdReply
                        || m.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.externalAdReply;
                    if (ad) {
                        texto = ad.title || ad.body || ad.sourceId || '';
                        if (texto) console.log('📣 Texto extraído del anuncio CTWA:', texto);
                    }
                }
                // Formato 4 (último recurso): buscar recursivamente cualquier texto en el mensaje
                if (!texto) {
                    texto = buscarTextoProfundo(m);
                    if (texto) console.log('🔎 Texto extraído por búsqueda profunda:', texto.slice(0,60));
                }
                // Log de diagnóstico de mensajes que siguen sin texto
                if (!texto) {
                    console.log('🔍 Mensaje sin texto. Estructura:', JSON.stringify(m).slice(0, 400));
                }
                let mediaBuffer = null;

                if (msg.message?.imageMessage || msg.message?.documentMessage) {
                    tipo = 'image';
                    texto = msg.message?.imageMessage?.caption || '';
                    try { mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}); }
                    catch (e) { console.error('Error descargando imagen:', e.message); }
                } else if (msg.message?.audioMessage) {
                    tipo = 'audio';
                    try { mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}); }
                    catch (e) { console.error('Error descargando audio:', e.message); }
                }

                const msgData = { numero, nombre, tipo, texto, mediaBuffer };

                if (!preKeysReady) {
                    console.log('⏳ Mensaje encolado (inicializando pre-keys)...');
                    msgQueue.push(msgData);
                } else {
                    const { procesarMensaje } = require('./botService');
                    await procesarMensaje(msgData);
                }
            } catch (e) {
                console.error('Error procesando mensaje WA:', e.message);
            }
        }
    });
}

async function getQRImage() {
    if (!qrData) return null;
    try { return await QRCode.toDataURL(qrData); } catch (e) { return null; }
}

module.exports = { iniciar, getClient, getQR, getQRImage, getStatus, resetAndRestart, resolveLid, getLastMsg };
