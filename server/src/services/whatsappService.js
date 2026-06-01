const { getClient, resolveLid, getLastMsgKey } = require('./whatsappClient');

async function enviarTexto(numero, texto) {
    const sock = getClient();
    if (!sock) { console.error('WhatsApp no conectado'); return null; }

    // JID original tal como llegó en el mensaje (puede ser @lid)
    const originalJid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;

    // Intentar resolver @lid → @s.whatsapp.net
    const sendJid = resolveLid(originalJid);

    // Responder citando el último mensaje recibido de este contacto.
    // Esto usa la sesión E2E ya establecida al recibir, evitando error 463
    // que ocurre cuando WhatsApp no puede crear una sesión nueva para @lid.
    const lastKey = getLastMsgKey(originalJid);
    const sendOpts = {};
    if (lastKey) {
        sendOpts.quoted = { key: lastKey, message: { conversation: '' } };
        console.log('📤 Enviando como respuesta citada →', sendJid);
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
