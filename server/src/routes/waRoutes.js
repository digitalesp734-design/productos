const router = require('express').Router();
const { getQRImage, getStatus, resetAndRestart } = require('../services/whatsappClient');
const auth = require('../middleware/auth');

router.get('/status', auth, async (req, res) => {
    const status = getStatus();
    const qrImage = await getQRImage();
    res.json({ ok: true, status, qrImage });
});

router.post('/restart', auth, async (req, res) => {
    res.json({ ok: true, mensaje: 'Reiniciando WhatsApp — el QR aparecerá en unos segundos' });
    // Ejecutar después de responder para no bloquear
    setTimeout(() => resetAndRestart().catch(console.error), 200);
});

module.exports = router;
