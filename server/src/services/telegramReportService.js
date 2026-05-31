const cron       = require('node-cron');
const { Op }     = require('sequelize');
const { Venta, Conversacion, Producto } = require('../models');
const { notificarTelegram } = require('./botService');

const fmt = p => `$${parseInt(p).toLocaleString('es-CO')}`;

function barra(valor, total, largo = 10) {
    if (!total) return '░'.repeat(largo);
    const lleno = Math.round((valor / total) * largo);
    return '█'.repeat(lleno) + '░'.repeat(largo - lleno);
}

async function generarReporteDiario() {
    const hoy = new Date().toISOString().slice(0, 10);
    const inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        .toISOString().slice(0, 10);

    // Ventas del día
    const ventasHoy = await Venta.findAll({
        where: { fecha: hoy, estado: 'completada' }
    });

    const ingresosHoy = ventasHoy.reduce((s, v) => s + parseInt(v.monto), 0);

    // Ventas del mes
    const ventasMes = await Venta.findAll({
        where: {
            fecha: { [Op.gte]: inicioMes },
            estado: 'completada'
        }
    });
    const ingresosMes = ventasMes.reduce((s, v) => s + parseInt(v.monto), 0);

    // Conversaciones activas
    const chatsActivos = await Conversacion.count({
        where: {
            estado: { [Op.in]: ['menu', 'esperando_email', 'esperando_comprobante', 'viendo_producto'] }
        }
    });

    // Pendientes de pago
    const pendientes = await Conversacion.count({ where: { estado: 'esperando_comprobante' } });

    // Top producto del día
    const topMes = {};
    for (const v of ventasMes) {
        topMes[v.producto_id] = (topMes[v.producto_id] || 0) + 1;
    }
    const topId = Object.entries(topMes).sort((a, b) => b[1] - a[1])[0]?.[0];
    const topProducto = topId ? await Producto.findByPk(topId) : null;

    // Tasa de conversión del mes
    const totalConversaciones = await Conversacion.count();
    const tasaConversion = totalConversaciones > 0
        ? Math.round((ventasMes.length / totalConversaciones) * 100)
        : 0;

    // Meta diaria (configurable)
    const metaDiaria = parseInt(process.env.META_VENTAS_DIA || '3');

    const emoji  = ingresosHoy > 0 ? '🚀' : '😴';
    const fecha  = new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });

    const msg = `${emoji} *Reporte Diario — Product Digital*
📅 ${fecha}

━━━━━━━━━━━━━━━━━━━━━━
💰 *HOY*
   Ventas: ${ventasHoy.length} | Ingresos: *${fmt(ingresosHoy)}*
   ${barra(ventasHoy.length, metaDiaria)} ${ventasHoy.length}/${metaDiaria} (meta diaria)

📊 *ESTE MES*
   Ventas: ${ventasMes.length} | Ingresos: *${fmt(ingresosMes)}*
   Tasa de conversión: ${tasaConversion}%

💬 *CHATS*
   Activos ahora: ${chatsActivos}
   Esperando pago: ${pendientes} ⏳

${topProducto ? `🏆 *Top producto:* ${topProducto.nombre}` : ''}
━━━━━━━━━━━━━━━━━━━━━━
${pendientes > 0 ? `\n⚠️ Tienes *${pendientes}* compradores esperando respuesta. Revisa el panel.` : '\n✅ Todo al día — sin pendientes.'}`;

    await notificarTelegram(msg);
    console.log('[TelegramReport] Reporte diario enviado');
}

async function reporteSemanal() {
    const hace7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

    const ventas = await Venta.findAll({
        where: { fecha: { [Op.gte]: hace7d }, estado: 'completada' }
    });

    const ingresos = ventas.reduce((s, v) => s + parseInt(v.monto), 0);

    // Top 3 productos
    const conteo = {};
    for (const v of ventas) {
        conteo[v.producto_id] = (conteo[v.producto_id] || 0) + 1;
    }
    const top3 = await Promise.all(
        Object.entries(conteo)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(async ([id, cnt]) => {
                const p = await Producto.findByPk(id);
                return p ? `   ${cnt}x ${p.nombre}` : null;
            })
    );

    const msg = `📈 *Resumen Semanal — Product Digital*

💰 Ventas: *${ventas.length}*
💵 Ingresos: *${fmt(ingresos)}*
📊 Promedio diario: *${fmt(Math.round(ingresos / 7))}*

🏆 *Top productos:*
${top3.filter(Boolean).join('\n') || '   Sin ventas esta semana'}

${ventas.length === 0 ? '💡 Esta semana sin ventas. Revisa el sistema de prospección.' : '🚀 ¡Excelente semana!'}`;

    await notificarTelegram(msg);
    console.log('[TelegramReport] Reporte semanal enviado');
}

function iniciarTelegramReportService() {
    // Reporte diario: 9pm hora Colombia (2am UTC)
    cron.schedule('0 2 * * *', generarReporteDiario, { timezone: 'America/Bogota' });
    // Reporte semanal: lunes 8am Colombia (1pm UTC)
    cron.schedule('0 13 * * 1', reporteSemanal, { timezone: 'America/Bogota' });
    console.log('✅ Reportes Telegram activos (diario 9pm + semanal lunes 8am)');
}

module.exports = { iniciarTelegramReportService, generarReporteDiario };
