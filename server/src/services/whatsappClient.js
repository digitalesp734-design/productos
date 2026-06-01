const path = require('path');
const fs   = require('fs');
const QRCode = require('qrcode');

let sock = null;
let qrData = null;
let status = 'disconnected';
let preKeysReady = false;
const msgQueue = [];

// Último mensaje completo recibido por JID — para respuestas citadas
const lastMsg = new Map();

// Cache LID → JID de teléfono
const lidCache = {};

function detectAuthFolder() {
    const envFolder = process.env.WA_AUTH_FOLDER;
    if (envFolder && envFolder !== '/app/wa_auth') return envFolder;
    const candidates = ['/data/wa_auth', '/var/data/wa_auth', '/mnt/wa_auth'];
    for (const c of candidates) {
        try {
            fs.mkdirSync(path.dirname(c), { recursive: true });
            fs.writeFileSync(path.join(path.dirname(c), '.test'), '1');
            fs.unlinkSync(path.join(path.dirname(c), '.test'));
            console.log('📁 Usando volumen persistente:', c);
            return c;
        } catch {}
    }
    console.log('📁 Usando /app/wa_auth (no persistente entre deploys)');
    return path.join(process.cwd(), 'wa_auth');
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
            makeInMemoryStore } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    console.log('📱 Usando WhatsApp Web versión:', version.join('.'));

    // Store en memoria para manejo automático de contactos, chats y sesiones
    const store = makeInMemoryStore ? makeInMemoryStore({}) : null;

    sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: true,
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
        }

        if (connection === 'close') {
            status = 'disconnected';
            qrData = null;
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            console.log('WhatsApp desconectado, código:', code);
            if (loggedOut) {
                console.log('Sesión revocada — limpiando credenciales...');
                // Remover saveCreds ANTES de limpiar para evitar que re-grabe las creds inválidas
                try { sock.ev.removeAllListeners('creds.update'); } catch {}
                limpiarCredenciales();
                // Segunda limpieza 300ms después por si saveCreds async ya estaba corriendo
                setTimeout(() => {
                    limpiarCredenciales();
                    iniciar();
                }, 300);
            } else {
                console.log('Reconectando en 5 segundos...');
                setTimeout(iniciar, 5000);
            }
        }

        if (connection === 'open') {
            status = 'ready';
            qrData = null;
            preKeysReady = false;
            console.log('✅ WhatsApp conectado — esperando 30s para pre-keys...');
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
            }, 30000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const jid = msg.key.remoteJid || '';
            if (jid.includes('@g.us') || jid === 'status@broadcast') continue;

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
                let texto = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || '';
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
