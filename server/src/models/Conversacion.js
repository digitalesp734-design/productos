const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Conversacion = sequelize.define('Conversacion', {
    numero_wa:       { type: DataTypes.STRING(50), allowNull: false, unique: true },
    nombre_cliente:  { type: DataTypes.STRING(200) },
    estado:          { type: DataTypes.ENUM('nuevo','menu','viendo_producto','esperando_email','esperando_comprobante','completado'), defaultValue: 'nuevo' },
    producto_id:     { type: DataTypes.INTEGER },
    email_cliente:   { type: DataTypes.STRING(200) },
    ultimo_mensaje:  { type: DataTypes.TEXT },
    historial:       { type: DataTypes.JSON, defaultValue: [] },
}, { timestamps: true });

module.exports = Conversacion;
