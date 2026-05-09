const router = require('express').Router();
const { Venta, Producto } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');

router.get('/', auth, async (req, res) => {
    const { fecha, estado } = req.query;
    const where = {};
    if (fecha)  where.fecha  = fecha;
    if (estado) where.estado = estado;
    const ventas = await Venta.findAll({ where, include: [{ model: Producto, as: 'producto' }], order: [['createdAt','DESC']] });
    res.json({ ok: true, ventas });
});

router.put('/:id', auth, async (req, res) => {
    try {
        const v = await Venta.findByPk(req.params.id);
        if (!v) return res.status(404).json({ ok: false, msg: 'No encontrada' });
        await v.update(req.body);
        res.json({ ok: true, venta: v });
    } catch (e) { res.status(400).json({ ok: false, msg: e.message }); }
});

module.exports = router;
