const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Venta = sequelize.define('Venta', {
    numero_wa:       { type: DataTypes.STRING(50), allowNull: false },
    nombre_cliente:  { type: DataTypes.STRING(200) },
    producto_id:     { type: DataTypes.INTEGER, allowNull: false },
    monto:           { type: DataTypes.INTEGER, allowNull: false },
    comprobante_url: { type: DataTypes.TEXT },
    estado:          { type: DataTypes.ENUM('pendiente','completada','rechazada'), defaultValue: 'pendiente' },
    link_enviado:    { type: DataTypes.TEXT },
    email_cliente:   { type: DataTypes.STRING(200) },
    notas:           { type: DataTypes.TEXT },
    fecha:           { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
}, { timestamps: true });

module.exports = Venta;
