const router = require('express').Router();
const { CajaMovimiento, Venta } = require('../models');
const auth = require('../middleware/auth');
const sequelize = require('../config/db');

router.get('/resumen', auth, async (req, res) => {
    const hoy = new Date().toISOString().slice(0, 10);
    const fecha = req.query.fecha || hoy;
    const [rows] = await sequelize.query(
        `SELECT tipo, SUM(monto) as total FROM CajaMovimientos WHERE fecha = ? GROUP BY tipo`,
        { replacements: [fecha] }
    );
    const ingRow = rows.find(r => r.tipo === 'ingreso') || { total: 0 };
    const egrRow = rows.find(r => r.tipo === 'egreso')  || { total: 0 };
    const movimientos = await CajaMovimiento.findAll({
        where: { fecha },
        include: [{ model: Venta, as: 'venta', attributes: ['id'], required: false }],
        order: [['createdAt', 'DESC']]
    });
    res.json({
        ok: true,
        resumen: { ingresos: parseFloat(ingRow.total) || 0, egresos: parseFloat(egrRow.total) || 0 },
        movimientos
    });
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
