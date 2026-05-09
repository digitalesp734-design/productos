const router = require('express').Router();
const ctrl   = require('../controllers/webhookController');

router.get('/',  ctrl.verificar);
router.post('/', ctrl.recibir);

module.exports = router;
