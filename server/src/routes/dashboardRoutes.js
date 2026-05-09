const router = require('express').Router();
const sequelize = require('../config/db');
const auth = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
    const hoy = new Date().toISOString().slice(0, 10);
    const [ventasHoy]   = await sequelize.query(`SELECT COUNT(*) as total, COALESCE(SUM(monto),0) as ingresos FROM Ventas WHERE fecha = ? AND estado = 'completada'`, { replacements: [hoy] });
    const [ventasMes]   = await sequelize.query(`SELECT COUNT(*) as total, COALESCE(SUM(monto),0) as ingresos FROM Ventas WHERE DATE_FORMAT(fecha,'%Y-%m') = DATE_FORMAT(NOW(),'%Y-%m') AND estado = 'completada'`);
    const [topProductos]= await sequelize.query(`SELECT p.nombre, COUNT(*) as ventas, SUM(v.monto) as total FROM Ventas v JOIN Productos p ON p.id = v.producto_id WHERE v.estado = 'completada' GROUP BY v.producto_id ORDER BY ventas DESC LIMIT 5`);
    const [pendientes]  = await sequelize.query(`SELECT COUNT(*) as total FROM Ventas WHERE estado = 'pendiente'`);
    res.json({
        ok: true,
        hoy:         { ventas: ventasHoy[0]?.total || 0, ingresos: ventasHoy[0]?.ingresos || 0 },
        mes:         { ventas: ventasMes[0]?.total || 0, ingresos: ventasMes[0]?.ingresos || 0 },
        top_productos: topProductos,
        pendientes:  pendientes[0]?.total || 0
    });
});

module.exports = router;
