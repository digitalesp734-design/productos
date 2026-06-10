const router = require('express').Router();
const { Producto } = require('../models');
const auth = require('../middleware/auth');

// Endpoint temporal para actualizar precio via secret (no requiere auth)
router.post('/actualizar-precio-secret', async (req, res) => {
    const { secret, nombre_like, precio } = req.body;
    if (!secret || secret !== process.env.RESET_SECRET) return res.status(403).json({ ok: false, msg: 'Acceso denegado' });
    try {
        const { Op } = require('sequelize');
        const p = await Producto.findOne({ where: { nombre: { [Op.like]: `%${nombre_like}%` } } });
        if (!p) return res.status(404).json({ ok: false, msg: 'Producto no encontrado' });
        await p.update({ precio });
        res.json({ ok: true, producto: { id: p.id, nombre: p.nombre, precio: p.precio } });
    } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

router.get('/', auth, async (req, res) => {
    const productos = await Producto.findAll({ order: [['orden','ASC'],['createdAt','ASC']] });
    res.json({ ok: true, productos });
});

router.post('/', auth, async (req, res) => {
    try {
        const p = await Producto.create(req.body);
        res.json({ ok: true, producto: p });
    } catch (e) { res.status(400).json({ ok: false, msg: e.message }); }
});

router.put('/:id', auth, async (req, res) => {
    try {
        const p = await Producto.findByPk(req.params.id);
        if (!p) return res.status(404).json({ ok: false, msg: 'No encontrado' });
        await p.update(req.body);
        res.json({ ok: true, producto: p });
    } catch (e) { res.status(400).json({ ok: false, msg: e.message }); }
});

router.delete('/:id', auth, async (req, res) => {
    const p = await Producto.findByPk(req.params.id);
    if (!p) return res.status(404).json({ ok: false, msg: 'No encontrado' });
    await p.update({ activo: false });
    res.json({ ok: true });
});

module.exports = router;
