const path = require('path');
const fs   = require('fs');
const QRCode = require('qrcode');

let sock = null;
let qrData = null;
let status = 'disconnected';
let preKeysReady = false;       // true 20s después de conectar (pre-keys subidas)
const msgQueue = [];            // mensajes recibidos antes de que las pre-keys estén listas

// Cache LID → JID de teléfono (@s.whatsapp.net)
// Se llena con contacts.upsert durante el sync de historial
const lidCache = {};

// Detectar automáticamente la ruta del volumen de Railway
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

// Cargar cache LID persistido del volumen
function loadLidCache() {
    try {
        if (fs.existsSync(LID_CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(LID_CACHE_FILE, 'utf-8'));
            Object.assign(lidCache, data);
            console.log(`📞 Cache LID cargado: ${Object.keys(lidCache).length} contactos`);
        }
    } catch {}
}

function saveLidCache() {
    try {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        fs.writeFileSync(LID_CACHE_FILE, JSON.stringify(lidCache));
    } catch {}
}

// Resolver @lid → @s.whatsapp.net usando el cache
// Enviar a @s.whatsapp.net evita error 463 (WhatsApp no puede establecer sesión E2E con @lid)
function resolveLid(jid) {
    if (!jid || !jid.endsWith('@lid')) return jid;
    const resolved = lidCache[jid];
    if (resolved) {
        console.log(`📞 LID resuelto: ${jid} → ${resolved}`);
        return resolved;
    }
    console.log(`⚠️  LID sin resolver: ${jid} (enviando igual, puede fallar)`);
    return jid;
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
            downloadMediaMessage, Browsers, fetchLatestBaileysVersion } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    console.log('📱 Usando WhatsApp Web versión:', version.join('.'));

    sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        getMessage: async () => ({ conversation: '' }),
    });

    sock.ev.on('creds.update', saveCreds);

    // Construir cache LID → teléfono desde sync de contactos
    // WhatsApp envía estos eventos durante el primer sync de historial
    sock.ev.on('contacts.upsert', (contacts) => {
        let updated = 0;
        for (const c of contacts) {
            // c.id es el JID principal (@s.whatsapp.net o @lid)
            // c.lid es el LID cuando el JID principal es el teléfono
            if (c.lid && c.id && c.id.endsWith('@s.whatsapp.net')) {
                lidCache[c.lid] = c.id;
                updated++;
            }
            // También mapear al revés: si el id ya es @lid, registrar ambos lados
            if (c.id && c.id.endsWith('@lid')) {
                // No tenemos el teléfono directamente — ignorar por ahora
            }
        }
        if (updated > 0) {
            console.log(`📞 Cache LID actualizado: +${updated} contactos (total ${Object.keys(lidCache).length})`);
            saveLidCache();
        }
    });

    sock.ev.on('contacts.update', (updates) => {
        let updated = 0;
        for (const c of updates) {
            if (c.lid && c.id && c.id.endsWith('@s.whatsapp.net')) {
                lidCache[c.lid] = c.id;
                updated++;
            }
        }
        if (updated > 0) {
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
                console.log('Sesión cerrada por WhatsApp — generando nuevo QR...');
                limpiarCredenciales();
                setTimeout(iniciar, 3000);
            } else {
                console.log('Reconectando en 5 segundos...');
                setTimeout(iniciar, 5000);
            }
        }

        if (connection === 'open') {
            status = 'ready';
            qrData = null;
            preKeysReady = false;
            console.log('✅ WhatsApp conectado — esperando 30s para pre-keys y sync...');
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
                    console.log('⏳ Mensaje recibido durante inicialización, encolado...');
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

module.exports = { iniciar, getClient, getQR, getQRImage, getStatus, resetAndRestart, resolveLid };
