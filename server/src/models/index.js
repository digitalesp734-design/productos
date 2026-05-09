const Producto      = require('./Producto');
const Conversacion  = require('./Conversacion');
const Venta         = require('./Venta');
const CajaMovimiento = require('./CajaMovimiento');
const Usuario       = require('./Usuario');

Venta.belongsTo(Producto, { foreignKey: 'producto_id', as: 'producto' });
Producto.hasMany(Venta,   { foreignKey: 'producto_id', as: 'ventas' });

CajaMovimiento.belongsTo(Venta, { foreignKey: 'venta_id', as: 'venta' });

module.exports = { Producto, Conversacion, Venta, CajaMovimiento, Usuario };
