/* ===== Finanzas personales de Cristian — cierre de caja + control por Telegram ===== */
const cron   = require('node-cron');
const { Op } = require('sequelize');
const { Venta, Producto, FinanzaMov, FinanzaConfig } = require('../models');

const TOKEN  = process.env.PLATAFORMA_TELEGRAM_TOKEN;
const CHAT   = process.env.PLATAFORMA_TELEGRAM_CHAT_ID; // chat personal de Cristian (único autorizado)
const fmt    = n => '$' + Math.round(n||0).toLocaleString('es-CO');
const hoyStr = () => new Date().toISOString().slice(0,10);

// ---------- Config (clave-valor) ----------
async function cfg(clave, def=null){
    const r = await FinanzaConfig.findOne({ where:{ clave } });
    return r ? r.valor : def;
}
async function cfgInt(clave, def=0){ return parseInt(await cfg(clave)) || def; }
async function setCfg(clave, valor){
    const r = await FinanzaConfig.findOne({ where:{ clave } });
    if (r) await r.update({ valor:String(valor) });
    else   await FinanzaConfig.create({ clave, valor:String(valor) });
}
async function seedFinanzas(){
    const defaults = {
        gastos_fijos_mes:   '524000', // arriendo 250 + comida 100 + claude 80 + celular 54 + alojamiento 40
        meta_diaria_deuda:  '30000',
        tope_personal_sem:  '80000',
    };
    for (const [k,v] of Object.entries(defaults)){
        if (await FinanzaConfig.findOne({ where:{ clave:k } }) === null) await setCfg(k,v);
    }
}

// ---------- Telegram ----------
async function tg(texto){
    if (!TOKEN || !CHAT) return;
    try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ chat_id: CHAT, text: texto, parse_mode:'Markdown' })
        });
    } catch(e){ console.error('[Finanzas] tg error:', e.message); }
}

// ---------- Cierre de caja: ventas del día → ingreso personal, desglosado por producto ----------
async function cierreCaja(silencioso=false){
    const hoy = hoyStr();
    const ventas = await Venta.findAll({
        where:{ fecha: hoy, estado:'completada' },
        include:[{ model:Producto, as:'producto', required:false }]
    });
    if (!ventas.length){
        if (!silencioso) await tg(`🌙 *Cierre de caja* — ${hoy}\n\nHoy no hubo ventas registradas. ¡Mañana es otro día! 💪`);
        return { total:0, porProducto:{} };
    }
    // Agrupar por producto
    const porProd = {};
    let total = 0;
    for (const v of ventas){
        const nom = v.producto?.nombre || 'Otro';
        porProd[nom] = (porProd[nom]||0) + parseInt(v.monto);
        total += parseInt(v.monto);
    }
    // Evitar duplicar: si ya se registró el cierre de hoy, no repetir
    const yaReg = await FinanzaMov.findOne({ where:{ origen:'cierre_caja', fecha:hoy } });
    if (!yaReg){
        for (const [nom,monto] of Object.entries(porProd)){
            await FinanzaMov.create({ tipo:'ingreso', monto, categoria:'Productos digitales',
                producto:nom, origen:'cierre_caja', nota:`Ventas ${hoy}`, fecha:hoy });
        }
    }
    // Mensaje con desglose
    const lineas = Object.entries(porProd).sort((a,b)=>b[1]-a[1])
        .map(([n,m])=>`   • ${n}: *${fmt(m)}*`).join('\n');
    const disp = await calcularDisponible();
    await tg(`🌙 *Cierre de caja* — ${hoy}\n\n💰 Vendiste hoy: *${fmt(total)}* (${ventas.length} ventas)\n${lineas}\n\n${yaReg?'(ya estaba registrado)':'✅ Sumado a tus ingresos.'}\n\n🎯 Para tu meta de deuda hoy necesitas *${fmt(disp.metaDiaDeuda)}*.\n🛍️ Puedes gastar en personal hoy: *${fmt(Math.max(0,disp.hoy))}*`);
    return { total, porProducto:porProd };
}

// ---------- Cálculo: cuánto puede gastar (compras responsables) ----------
async function calcularDisponible(){
    const ahora = new Date();
    const y = ahora.getFullYear(), m = ahora.getMonth();
    const diasMes = new Date(y, m+1, 0).getDate();
    const diaActual = ahora.getDate();
    const diasRest = Math.max(1, diasMes - diaActual + 1);
    const inicioMes = new Date(y, m, 1).toISOString().slice(0,10);

    const movs = await FinanzaMov.findAll({ where:{ fecha:{ [Op.gte]: inicioMes } } });
    const ingresosMes = movs.filter(x=>x.tipo==='ingreso').reduce((s,x)=>s+x.monto,0);
    const personalMes = movs.filter(x=>x.tipo==='gasto' && x.personal).reduce((s,x)=>s+x.monto,0);

    const fijos      = await cfgInt('gastos_fijos_mes', 524000);
    const metaDia    = await cfgInt('meta_diaria_deuda', 30000);
    const metaDeudaMes = metaDia * diasMes;

    // Lo que sobra este mes para gastos personales/salidas
    const disponibleMes = ingresosMes - fijos - metaDeudaMes - personalMes;
    const hoy = Math.floor(disponibleMes / diasRest);
    return { ingresosMes, fijos, metaDeudaMes, metaDiaDeuda:metaDia, personalMes, disponibleMes, hoy, diasRest };
}

// ---------- Comandos de Telegram ----------
function parseMonto(txt){
    // captura 15000, 15.000, 15 mil, 15k
    let t = txt.toLowerCase().replace(/\./g,'');
    let mMil = t.match(/(\d+)\s*(mil|k)\b/);
    if (mMil) return parseInt(mMil[1]) * 1000;
    let m = t.match(/(\d{3,})/);
    return m ? parseInt(m[1]) : null;
}
const ES_PERSONAL = /salida|rumba|cerveza|trago|amig|fiesta|cine|paseo|restaurante|comida.*calle|antojo|personal|gusto|ropa|domicilio/i;

async function procesarComando(texto){
    const t = texto.trim().toLowerCase();

    // Ayuda
    if (t==='/start' || t==='ayuda' || t==='hola' || t==='menu'){
        return `👋 *Orden Cristian — tu asistente financiero*\n\nEscríbeme cosas como:\n• _gasté 15000 en almuerzo_\n• _gasté 30000 en salida_ (lo cuenta como personal)\n• _ingreso 50000 moto_\n• _cuánto puedo gastar_\n• _saldo_ / _cómo voy_\n• _ventas hoy_\n• _cerrar caja_\n• _meta deuda 50000_ (ajusta tu meta diaria)`;
    }

    // Ajustar meta diaria de deuda
    let mMeta = t.match(/meta\s*(deuda|diaria)?\s*(\d[\d.]*)/);
    if (mMeta){ const v=parseMonto(t); if(v){ await setCfg('meta_diaria_deuda',v); return `✅ Listo. Tu meta diaria de deuda ahora es *${fmt(v)}*.`; } }

    // ¿Cuánto puedo gastar?
    if (/cu[aá]nto.*(gastar|puedo|tengo|queda)/.test(t) || t==='disponible'){
        const d = await calcularDisponible();
        if (d.disponibleMes <= 0)
            return `🛑 Este mes vas justo. Después de tus gastos fijos (${fmt(d.fijos)}) y tu meta de deuda (${fmt(d.metaDeudaMes)}), no te sobra para gastos personales.\n\nIngresos del mes: ${fmt(d.ingresosMes)}. Mejor cuídate estos días 💪`;
        return `🛍️ *Puedes gastar hoy: ${fmt(Math.max(0,d.hoy))}*\n\nEste mes te quedan *${fmt(d.disponibleMes)}* para personal (${d.diasRest} días).\n\n_Ya desconté tus gastos fijos y tu meta de deuda. Gasta tranquilo dentro de eso 😉_`;
    }

    // Saldo / resumen
    if (/saldo|resumen|c[oó]mo voy|como voy|balance/.test(t)){
        const d = await calcularDisponible();
        return `📊 *Tu mes hasta hoy*\n\n📥 Ingresos: *${fmt(d.ingresosMes)}*\n🏠 Gastos fijos: ${fmt(d.fijos)}\n🎯 Meta deuda mes: ${fmt(d.metaDeudaMes)}\n🛍️ Personal gastado: ${fmt(d.personalMes)}\n\n💵 Te queda para personal: *${fmt(Math.max(0,d.disponibleMes))}*`;
    }

    // Ventas de hoy
    if (/ventas?\s*(hoy|de hoy)?$/.test(t) || t==='ventas'){
        const r = await cierreCaja(true);
        if (!r.total) return '📭 Hoy aún no hay ventas registradas.';
        const lineas = Object.entries(r.porProducto).sort((a,b)=>b[1]-a[1]).map(([n,m])=>`• ${n}: ${fmt(m)}`).join('\n');
        return `💰 *Ventas de hoy: ${fmt(r.total)}*\n${lineas}`;
    }

    // Cerrar caja manual
    if (/cerrar caja|cierre/.test(t)){ await cierreCaja(); return null; }

    // Registrar ingreso manual: "ingreso 50000 moto"
    if (/^(ingreso|me entr|recib|gan[eé])/.test(t)){
        const v = parseMonto(t);
        if (!v) return '¿Cuánto? Escríbelo así: _ingreso 50000 moto_';
        const cat = t.replace(/^(ingreso|me entr[oó]|recib[ií]|gan[eé])\s*/,'').replace(/\d[\d.]*\s*(mil|k)?/,'').trim() || 'Otro';
        await FinanzaMov.create({ tipo:'ingreso', monto:v, categoria:cat||'Otro', origen:'telegram', nota:texto, fecha:hoyStr() });
        return `📥 Ingreso registrado: *${fmt(v)}* (${cat}).`;
    }

    // Registrar gasto: "gasté 15000 en comida"
    if (/^(gast[eé]|gasto|pagu[eé]|compr[eé])/.test(t)){
        const v = parseMonto(t);
        if (!v) return '¿Cuánto gastaste? Escríbelo así: _gasté 15000 en comida_';
        const cat = t.replace(/^(gast[eé]|gasto|pagu[eé]|compr[eé])\s*/,'').replace(/\d[\d.]*\s*(mil|k)?/,'').replace(/\b(en|de|el|la|por)\b/g,'').trim() || 'Otro';
        const personal = ES_PERSONAL.test(t);
        await FinanzaMov.create({ tipo:'gasto', monto:v, categoria:cat||'Otro', personal, origen:'telegram', nota:texto, fecha:hoyStr() });
        const d = await calcularDisponible();
        return `📤 Gasto registrado: *${fmt(v)}*${personal?' 🛍️ (personal)':''} en ${cat}.\n${personal?`Te quedan hoy para personal: *${fmt(Math.max(0,d.hoy))}*`:''}`;
    }

    return null; // no entendido → no responder (evita ruido)
}

// ---------- Long polling de Telegram ----------
let offset = 0, polling = false;
async function poll(){
    if (!TOKEN || !CHAT) return;
    polling = true;
    try {
        const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=30&offset=${offset}`);
        const data = await r.json();
        if (data.ok && data.result.length){
            for (const u of data.result){
                offset = u.update_id + 1;
                const msg = u.message;
                if (!msg || !msg.text) continue;
                if (String(msg.chat.id) !== String(CHAT)) continue; // solo Cristian
                try {
                    const resp = await procesarComando(msg.text);
                    if (resp) await tg(resp);
                } catch(e){ console.error('[Finanzas] cmd error:', e.message); }
            }
        }
    } catch(e){ /* timeout normal del long polling */ }
    setTimeout(poll, 1000);
}

// Descarta mensajes viejos al arrancar para no responder historial
async function drenar(){
    try {
        const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1`);
        const d = await r.json();
        if (d.ok && d.result.length) offset = d.result[d.result.length-1].update_id + 1;
    } catch(e){}
}

// ---------- Init ----------
async function iniciarFinanzasService(){
    if (!TOKEN || !CHAT){ console.log('⚠️ Finanzas: sin token/chat Telegram — módulo inactivo'); return; }
    await seedFinanzas();
    await drenar();
    // Cierre de caja automático: 11pm hora Colombia
    cron.schedule('0 23 * * *', () => cierreCaja().catch(e=>console.error('[Finanzas] cierre:', e.message)), { timezone:'America/Bogota' });
    if (!polling) poll();
    console.log('✅ Finanzas personales activo (cierre 11pm + comandos Telegram)');
}

module.exports = { iniciarFinanzasService, cierreCaja, calcularDisponible, procesarComando };
