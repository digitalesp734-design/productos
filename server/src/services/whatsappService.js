const { getClient } = require('./whatsappClient');

async function enviarTexto(numero, texto) {
    const sock = getClient();
    if (!sock) { console.error('WhatsApp no conectado'); return null; }

    // Usar el JID tal como viene — puede ser @s.whatsapp.net, @lid, o número solo
    let jid;
    if (numero.includes('@')) {
        jid = numero; // Ya tiene dominio (@s.whatsapp.net o @lid)
    } else {
        jid = `${numero}@s.whatsapp.net`; // Solo número → agregar dominio
    }

    try {
        const result = await sock.sendMessage(jid, { text: texto });
        console.log('✅ Enviado a', jid);
        return result;
    } catch (e) {
        console.error('❌ Error enviando a', jid, ':', e.message);

        // Si falla con @lid, intentar con @s.whatsapp.net
        if (jid.endsWith('@lid')) {
            try {
                const bareNum = jid.split('@')[0];
                const altJid  = `${bareNum}@s.whatsapp.net`;
                console.log('↩️  Reintentando con', altJid);
                const r2 = await sock.sendMessage(altJid, { text: texto });
                console.log('✅ Enviado (fallback) a', altJid);
                return r2;
            } catch (e2) {
                console.error('❌ Fallback también falló:', e2.message);
            }
        }
        return null;
    }
}

module.exports = { enviarTexto };
