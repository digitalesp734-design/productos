const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const CajaMovimiento = sequelize.define('CajaMovimiento', {
    tipo:      { type: DataTypes.ENUM('ingreso','egreso'), allowNull: false },
    monto:     { type: DataTypes.INTEGER, allowNull: false },
    concepto:  { type: DataTypes.STRING(300), allowNull: false },
    venta_id:  { type: DataTypes.INTEGER },
    fecha:     { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
}, { timestamps: true });

module.exports = CajaMovimiento;
