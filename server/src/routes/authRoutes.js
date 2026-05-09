const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { Usuario } = require('../models');

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const u = await Usuario.findOne({ where: { email, activo: true } });
        if (!u || !(await bcrypt.compare(password, u.password)))
            return res.status(401).json({ ok: false, msg: 'Credenciales incorrectas' });
        const token = jwt.sign({ id: u.id, rol: u.rol }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });
        res.json({ ok: true, token, user: { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol } });
    } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

module.exports = router;
