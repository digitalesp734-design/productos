const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Usuario = sequelize.define('Usuario', {
    nombre:   { type: DataTypes.STRING(150), allowNull: false },
    email:    { type: DataTypes.STRING(200), allowNull: false, unique: true },
    password: { type: DataTypes.STRING(255), allowNull: false },
    rol:      { type: DataTypes.ENUM('admin','operador'), defaultValue: 'operador' },
    activo:   { type: DataTypes.BOOLEAN, defaultValue: true },
}, { timestamps: true });

module.exports = Usuario;
