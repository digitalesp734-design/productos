const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Producto = sequelize.define('Producto', {
    nombre:      { type: DataTypes.STRING(200), allowNull: false },
    descripcion: { type: DataTypes.TEXT },
    precio:      { type: DataTypes.INTEGER, allowNull: false },
    link_drive:  { type: DataTypes.TEXT, allowNull: false },
    imagen_url:  { type: DataTypes.TEXT },
    activo:      { type: DataTypes.BOOLEAN, defaultValue: true },
    orden:       { type: DataTypes.INTEGER, defaultValue: 0 },
    es_combo:    { type: DataTypes.BOOLEAN, defaultValue: false },
    combo_ids:   { type: DataTypes.STRING(500) },
}, { timestamps: true });

module.exports = Producto;
