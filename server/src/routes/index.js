const router = require('express').Router();

router.use('/webhook',   require('./webhookRoutes'));
router.use('/auth',      require('./authRoutes'));
router.use('/productos', require('./productosRoutes'));
router.use('/ventas',    require('./ventasRoutes'));
router.use('/caja',      require('./cajaRoutes'));
router.use('/dashboard', require('./dashboardRoutes'));
router.use('/chats',     require('./chatsRoutes'));
router.use('/wa',        require('./waRoutes'));

module.exports = router;
