const { getClient, getLastMsg } = require('./whatsappClient');

async function enviarTexto(numero, texto) {
    const sock = getClient();
    if (!sock) { console.error('WhatsApp no conectado'); return null; }

    // Usar el JID EXACTO que vino en el mensaje recibido (@lid o @s.whatsapp.net)
    // La sesión Signal se establece al recibir y está keyed por ese JID.
    // Si resolviéramos @lid → @s.whatsapp.net, no encontraría la sesión.
    const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;

    // Pasar el mensaje original completo para quoted reply
    const quoted = getLastMsg(numero.includes('@') ? numero : `${numero}@s.whatsapp.net`);
    const sendOpts = quoted ? { quoted } : {};

    console.log('📤 Enviando a', jid, quoted ? '(quoted)' : '(directo)');

    try {
        const result = await sock.sendMessage(jid, { text: texto }, sendOpts);
        console.log('✅ Enviado a', jid);
        return result;
    } catch (e) {
        console.error('❌ Error enviando a', jid, ':', e.message);
        return null;
    }
}

module.exports = { enviarTexto };
