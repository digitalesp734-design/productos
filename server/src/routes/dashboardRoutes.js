const router = require('express').Router();
const { Venta, Producto, Conversacion } = require('../models');
const auth = require('../middleware/auth');
const { Op, fn, col, literal } = require('sequelize');

router.get('/', auth, async (req, res) => {
    try {
        const hoy = new Date().toISOString().slice(0, 10);
        const inicioMes = hoy.slice(0, 7) + '-01';

        const [ventasHoy, ventasMes, pendientes, topProductos, chatsTotal, chatsHoy] = await Promise.all([
            Venta.findAll({ where: { fecha: hoy, estado: 'completada' }, attributes: ['monto'] }),
            Venta.findAll({ where: { fecha: { [Op.gte]: inicioMes }, estado: 'completada' }, attributes: ['monto'] }),
            Venta.count({ where: { estado: 'pendiente' } }),
            Venta.findAll({
                where: { estado: 'completada' },
                attributes: ['producto_id', [fn('COUNT', col('Venta.id')), 'ventas'], [fn('SUM', col('monto')), 'total']],
                include: [{ model: Producto, as: 'producto', attributes: ['nombre'] }],
                group: ['producto_id', 'producto.id'],
                order: [[literal('ventas'), 'DESC']],
                limit: 5,
                raw: false,
            }),
            Conversacion.count(),
            Conversacion.count({ where: { updatedAt: { [Op.gte]: hoy + ' 00:00:00' } } }),
        ]);

        res.json({
            ok: true,
            hoy: {
                ventas: ventasHoy.length,
                ingresos: ventasHoy.reduce((s, v) => s + Number(v.monto), 0),
            },
            mes: {
                ventas: ventasMes.length,
                ingresos: ventasMes.reduce((s, v) => s + Number(v.monto), 0),
            },
            pendientes,
            top_productos: topProductos.map(t => ({
                nombre: t.producto?.nombre || '?',
                ventas: Number(t.get('ventas')),
                total: Number(t.get('total')),
            })),
            chats_total: chatsTotal,
            chats_hoy: chatsHoy,
        });
    } catch (e) {
        console.error('Dashboard error:', e.message);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

module.exports = router;
