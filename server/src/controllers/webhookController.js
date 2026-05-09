const { procesarMensaje } = require('../services/botService');

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'productdigital_webhook_2024';

// GET — verificación del webhook por Meta
function verificar(req, res) {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verificado por Meta');
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
}

// POST — mensajes entrantes de WhatsApp
async function recibir(req, res) {
    res.sendStatus(200); // responder rápido a Meta

    try {
        const entry = req.body?.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        if (!value?.messages?.length) return;

        const msg = value.messages[0];
        const contacto = value.contacts?.[0];
        const numero = msg.from;
        const nombre = contacto?.profile?.name || '';
        const tipo = msg.type;

        let texto = null;
        let mediaId = null;

        if (tipo === 'text') {
            texto = msg.text?.body || '';
        } else if (tipo === 'image') {
            mediaId = msg.image?.id;
            texto = msg.image?.caption || '';
        } else if (tipo === 'document') {
            mediaId = msg.document?.id;
        }

        await procesarMensaje({ numero, nombre, tipo, texto, mediaId });
    } catch (e) {
        console.error('Webhook error:', e.message);
    }
}

module.exports = { verificar, recibir };
