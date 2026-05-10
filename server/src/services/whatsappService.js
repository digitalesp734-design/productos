const { getClient } = require('./whatsappClient');

async function enviarTexto(numero, texto) {
    const sock = getClient();
    if (!sock) { console.error('WhatsApp no conectado'); return null; }
    const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    try {
        const result = await sock.sendMessage(jid, { text: texto });
        console.log('✅ Enviado a', jid);
        return result;
    } catch (e) {
        console.error('❌ Error enviando a', jid, ':', e.message);
        return null;
    }
}

module.exports = { enviarTexto };
