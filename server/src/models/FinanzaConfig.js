const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// Configuración de finanzas personales (clave-valor): meta diaria, gastos fijos, etc.
const FinanzaConfig = sequelize.define('FinanzaConfig', {
    clave: { type: DataTypes.STRING(60), allowNull: false, unique: true },
    valor: { type: DataTypes.TEXT },
}, { timestamps: true });

module.exports = FinanzaConfig;
