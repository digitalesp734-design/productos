const path = require('path');
const fs   = require('fs');
const QRCode = require('qrcode');

let sock = null;
let qrData = null;
let status = 'disconnected';
let preKeysReady = false;       // true 20s después de conectar (pre-keys subidas)
const msgQueue = [];            // mensajes recibidos antes de que las pre-keys estén listas

// Detectar automáticamente la ruta del volumen de Railway
function detectAuthFolder() {
    const envFolder = process.env.WA_AUTH_FOLDER;
    if (envFolder && envFolder !== '/app/wa_auth') return envFolder;
    // Buscar ruta del volumen Railway (/data, /var/data, /mnt/data)
    const candidates = ['/data/wa_auth', '/var/data/wa_auth', '/mnt/wa_auth'];
    for (const c of candidates) {
        try {
            fs.mkdirSync(path.dirname(c), { recursive: true });
            // Test de escritura
            fs.writeFileSync(path.join(path.dirname(c), '.test'), '1');
            fs.unlinkSync(path.join(path.dirname(c), '.test'));
            console.log('📁 Usando volumen persistente:', c);
            return c;
        } catch {}
    }
    // Fallback a /app/wa_auth
    console.log('📁 Usando /app/wa_auth (no persistente entre deploys)');
    return path.join(process.cwd(), 'wa_auth');
}

const AUTH_FOLDER = detectAuthFolder();

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

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers, fetchLatestBaileysVersion } = baileys;

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
                // Sesión revocada → limpiar credenciales y generar nuevo QR
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
            console.log('✅ WhatsApp conectado — esperando 20s para pre-keys...');
            // WhatsApp necesita ~15-20s para subir pre-keys de cifrado antes de poder enviar
            setTimeout(async () => {
                preKeysReady = true;
                console.log('✅ Pre-keys listas — bot 100% operativo');
                // Procesar mensajes que llegaron durante la espera
                if (msgQueue.length > 0) {
                    console.log(`📨 Procesando ${msgQueue.length} mensajes en cola...`);
                    for (const data of msgQueue) {
                        try { const { procesarMensaje } = require('./botService'); await procesarMensaje(data); }
                        catch (e) { console.error('Error procesando cola:', e.message); }
                    }
                    msgQueue.length = 0;
                }
            }, 20000);
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
                    // Pre-keys aún subiéndose — encolar para procesar después
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

module.exports = { iniciar, getClient, getQR, getQRImage, getStatus, resetAndRestart };
