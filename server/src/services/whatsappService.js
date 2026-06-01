const { getClient, resolveLid, getLastMsg } = require('./whatsappClient');

async function enviarTexto(numero, texto) {
    const sock = getClient();
    if (!sock) { console.error('WhatsApp no conectado'); return null; }

    const originalJid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    const sendJid = resolveLid(originalJid);

    // Pasar el mensaje original completo como quoted (no un mock)
    // Esto usa la sesión E2E real establecida al recibir el mensaje
    const quoted = getLastMsg(originalJid);
    const sendOpts = quoted ? { quoted } : {};

    if (quoted) {
        console.log('📤 Enviando como quoted reply →', sendJid);
    } else {
        console.log('📤 Enviando directo →', sendJid);
    }

    try {
        const result = await sock.sendMessage(sendJid, { text: texto }, sendOpts);
        console.log('✅ Enviado a', sendJid);
        return result;
    } catch (e) {
        console.error('❌ Error enviando a', sendJid, ':', e.message);
        return null;
    }
}

module.exports = { enviarTexto };
