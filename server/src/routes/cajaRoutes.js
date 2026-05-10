const router = require('express').Router();
const { CajaMovimiento, Venta } = require('../models');
const auth = require('../middleware/auth');
const { Op, fn, col } = require('sequelize');

router.get('/resumen', auth, async (req, res) => {
    try {
        const hoy = new Date().toISOString().slice(0, 10);
        const fecha = req.query.fecha || hoy;

        const movimientos = await CajaMovimiento.findAll({
            where: { fecha },
            include: [{ model: Venta, as: 'venta', attributes: ['id'], required: false }],
            order: [['createdAt', 'DESC']],
        });

        const ingresos = movimientos.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + Number(m.monto), 0);
        const egresos  = movimientos.filter(m => m.tipo === 'egreso').reduce((s, m) => s + Number(m.monto), 0);

        res.json({ ok: true, resumen: { ingresos, egresos }, movimientos });
    } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

router.post('/movimiento', auth, async (req, res) => {
    try {
        const { tipo, concepto, monto, fecha } = req.body;
        const m = await CajaMovimiento.create({
            tipo, concepto, monto,
            fecha: fecha || new Date().toISOString().slice(0, 10)
        });
        res.json({ ok: true, movimiento: m });
    } catch (e) { res.status(400).json({ ok: false, msg: e.message }); }
});

module.exports = router;
