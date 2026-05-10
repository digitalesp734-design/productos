const router = require('express').Router();
const { Conversacion, Producto } = require('../models');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');

router.get('/', auth, async (req, res) => {
    try {
        const { q } = req.query;
        const where = q ? {
            [Op.or]: [
                { numero_wa: { [Op.like]: `%${q}%` } },
                { nombre_cliente: { [Op.like]: `%${q}%` } },
            ]
        } : {};
        const chats = await Conversacion.findAll({
            where,
            include: [{ model: Producto, as: 'producto', attributes: ['nombre', 'precio'], required: false }],
            order: [['updatedAt', 'DESC']],
            limit: 100,
        });
        res.json({ ok: true, chats });
    } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

router.get('/:id', auth, async (req, res) => {
    try {
        const chat = await Conversacion.findByPk(req.params.id, {
            include: [{ model: Producto, as: 'producto', required: false }]
        });
        if (!chat) return res.status(404).json({ ok: false, msg: 'Chat no encontrado' });
        res.json({ ok: true, chat });
    } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

module.exports = router;
