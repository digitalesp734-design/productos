const Producto      = require('./Producto');
const Conversacion  = require('./Conversacion');
const Venta         = require('./Venta');
const CajaMovimiento = require('./CajaMovimiento');
const Usuario       = require('./Usuario');
const FinanzaMov    = require('./FinanzaMov');
const FinanzaConfig = require('./FinanzaConfig');

Venta.belongsTo(Producto,        { foreignKey: 'producto_id', as: 'producto' });
Producto.hasMany(Venta,          { foreignKey: 'producto_id', as: 'ventas' });
Conversacion.belongsTo(Producto, { foreignKey: 'producto_id', as: 'producto' });
CajaMovimiento.belongsTo(Venta,  { foreignKey: 'venta_id',   as: 'venta' });

module.exports = { Producto, Conversacion, Venta, CajaMovimiento, Usuario, FinanzaMov, FinanzaConfig };
