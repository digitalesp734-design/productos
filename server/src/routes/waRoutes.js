const router = require('express').Router();
const { getQRImage, getStatus } = require('../services/whatsappClient');
const auth = require('../middleware/auth');

router.get('/status', auth, async (req, res) => {
    const status = getStatus();
    const qrImage = await getQRImage();
    res.json({ ok: true, status, qrImage });
});

module.exports = router;
