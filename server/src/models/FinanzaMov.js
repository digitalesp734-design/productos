const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// Movimientos de finanzas PERSONALES de Cristian (separado de la caja del negocio)
const FinanzaMov = sequelize.define('FinanzaMov', {
    tipo:      { type: DataTypes.ENUM('ingreso','gasto'), allowNull: false },
    monto:     { type: DataTypes.INTEGER, allowNull: false },
    categoria: { type: DataTypes.STRING(120), allowNull: false }, // fuente (ingreso) o categoría (gasto)
    producto:  { type: DataTypes.STRING(160) },                   // para ventas: qué producto
    personal:  { type: DataTypes.BOOLEAN, defaultValue: false },  // gasto personal / salida
    origen:    { type: DataTypes.STRING(40), defaultValue: 'manual' }, // 'cierre_caja' | 'telegram' | 'manual'
    nota:      { type: DataTypes.STRING(300) },
    fecha:     { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
}, { timestamps: true });

module.exports = FinanzaMov;
