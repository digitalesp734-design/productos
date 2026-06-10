import React, { useEffect, useState, useMemo } from 'react';
import { api } from '../App';

const ESTADOS = {
    nuevo:                 { label: 'Nuevo',            color: '#3498db', icon: '🆕' },
    menu:                  { label: 'Viendo menú',      color: '#9b59b6', icon: '📋' },
    viendo_producto:       { label: 'Interesado',       color: '#f39c12', icon: '👀' },
    esperando_email:       { label: 'Listo para pagar', color: '#e74c3c', icon: '💳' },
    esperando_comprobante: { label: 'Enviando pago',    color: '#e67e22', icon: '⏳' },
    completado:            { label: 'Compró ✅',        color: '#25d366', icon: '✅' },
};

const PRODUCTOS_INFO = {
    capcut:      { label: 'CapCut',     color: '#ff4757', icon: '🎬' },
    combo:       { label: 'Combo',      color: '#ff6b81', icon: '📦' },
    n8n:         { label: 'n8n',        color: '#5352ed', icon: '🤖' },
    n8n_premium: { label: 'n8n Pro',    color: '#3742fa', icon: '⭐' },
    emula:       { label: 'Emuladora',  color: '#2ed573', icon: '🎮' },
};

function detectarProducto(chat) {
    const n = (chat.producto?.nombre || '').toLowerCase();
    if (!n) return null;
    if (n.includes('combo'))   return 'combo';
    if (n.includes('premium')) return 'n8n_premium';
    if (n.includes('capcut'))  return 'capcut';
    if (n.includes('n8n') || n.includes('agente')) return 'n8n';
    if (n.includes('emula'))   return 'emula';
    return null;
}

function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'ahora';
    if (m < 60) return `hace ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h}h`;
    return `hace ${Math.floor(h / 24)}d`;
}

const FILTROS = [
    { id: 'todos',       label: 'Todos',          icon: '💬', match: () => true },
    { id: 'capcut',      label: 'CapCut',          icon: '🎬', match: c => detectarProducto(c) === 'capcut' },
    { id: 'combo',       label: 'Combo',           icon: '📦', match: c => detectarProducto(c) === 'combo' },
    { id: 'n8n',         label: 'n8n',             icon: '🤖', match: c => ['n8n','n8n_premium'].includes(detectarProducto(c)) },
    { id: 'emula',       label: 'Emuladora',       icon: '🎮', match: c => detectarProducto(c) === 'emula' },
    { id: 'casi_compran',label: 'Casi compran 🔥', icon: '💳', match: c => ['esperando_email','esperando_comprobante'].includes(c.estado) },
    { id: 'compraron',   label: 'Compraron',       icon: '✅', match: c => c.estado === 'completado' },
];

export default function Chats() {
    const [chats, setChats]         = useState([]);
    const [seleccionado, setSeleccionado] = useState(null);
    const [busqueda, setBusqueda]   = useState('');
    const [filtroActivo, setFiltroActivo] = useState('todos');

    const cargar = (q = '') => api(`/chats${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(d => d.ok && setChats(d.chats));

    useEffect(() => { cargar(); }, []);

    useEffect(() => {
        const t = setTimeout(() => cargar(busqueda), 300);
        return () => clearTimeout(t);
    }, [busqueda]);

    const verDetalle = async (chat) => {
        const d = await api(`/chats/${chat.id}`);
        if (d.ok) setSeleccionado(d.chat);
    };

    const filtrados = useMemo(() => {
        const filtro = FILTROS.find(f => f.id === filtroActivo);
        return chats.filter(filtro?.match || (() => true));
    }, [chats, filtroActivo]);

    const conteos = useMemo(() =>
        Object.fromEntries(FILTROS.map(f => [f.id, chats.filter(f.match).length])),
    [chats]);

    return (
        <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 48px)' }}>

            {/* ── Panel izquierdo ────────────────────────────────────── */}
            <div style={{ width: 360, display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 }}>

                {/* Título + búsqueda */}
                <div style={{ marginBottom: 10 }}>
                    <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>💬 Chats</h2>
                    <input
                        value={busqueda} onChange={e => setBusqueda(e.target.value)}
                        placeholder="Buscar por número o nombre..."
                        style={{ width: '100%', padding: '9px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}
                    />
                </div>

                {/* Filtros por etiqueta */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
                    {FILTROS.map(f => {
                        const activo = filtroActivo === f.id;
                        const cnt    = conteos[f.id] || 0;
                        return (
                            <button key={f.id} onClick={() => setFiltroActivo(f.id)}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 4,
                                    padding: '5px 10px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                                    background: activo ? '#1a1a2e' : '#f0f0f0',
                                    color: activo ? '#fff' : '#555',
                                    transition: 'all .15s'
                                }}>
                                {f.icon} {f.label}
                                <span style={{ background: activo ? '#ffffff30' : '#00000015', borderRadius: 10, padding: '1px 6px', fontSize: 11 }}>
                                    {cnt}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {/* Lista */}
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {filtrados.length === 0 && (
                        <div style={{ textAlign: 'center', padding: 40, color: '#888', fontSize: 14 }}>
                            {busqueda ? 'Sin resultados para esa búsqueda.' : 'No hay chats en esta categoría.'}
                        </div>
                    )}
                    {filtrados.map(c => {
                        const est  = ESTADOS[c.estado] || ESTADOS.nuevo;
                        const prod = detectarProducto(c);
                        const pi   = prod ? PRODUCTOS_INFO[prod] : null;
                        const activo = seleccionado?.id === c.id;
                        return (
                            <div key={c.id} onClick={() => verDetalle(c)}
                                style={{
                                    background: activo ? '#f0fdf4' : '#fff',
                                    border: `2px solid ${activo ? '#25d366' : '#f0f0f0'}`,
                                    borderRadius: 12, padding: '11px 13px',
                                    cursor: 'pointer', transition: 'all .15s'
                                }}>
                                {/* Fila 1: nombre + tiempo */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                                        {c.nombre_cliente || c.numero_wa}
                                    </div>
                                    <div style={{ fontSize: 11, color: '#aaa', whiteSpace: 'nowrap', marginLeft: 6 }}>{timeAgo(c.updatedAt)}</div>
                                </div>

                                {/* Fila 2: número */}
                                <div style={{ color: '#aaa', fontSize: 11, marginTop: 2 }}>📱 {c.numero_wa}</div>

                                {/* Fila 3: último mensaje */}
                                <div style={{ color: '#666', fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {c.ultimo_mensaje || '—'}
                                </div>

                                {/* Fila 4: etiquetas */}
                                <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
                                    {/* Etiqueta de producto */}
                                    {pi && (
                                        <span style={{
                                            padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                                            background: pi.color + '20', color: pi.color
                                        }}>
                                            {pi.icon} {pi.label}
                                        </span>
                                    )}
                                    {/* Etiqueta de estado del embudo */}
                                    <span style={{
                                        padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                                        background: est.color + '20', color: est.color
                                    }}>
                                        {est.icon} {est.label}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ── Panel derecho: detalle del chat ───────────────────── */}
            <div style={{ flex: 1, background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,.06)', display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
                {!seleccionado ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aaa', fontSize: 15, flexDirection: 'column', gap: 8 }}>
                        <div style={{ fontSize: 40 }}>💬</div>
                        Selecciona un chat para ver la conversación
                    </div>
                ) : (
                    <>
                        {/* Header */}
                        <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <div style={{ fontWeight: 700, fontSize: 16 }}>{seleccionado.nombre_cliente || seleccionado.numero_wa}</div>
                                <div style={{ color: '#aaa', fontSize: 12 }}>📱 {seleccionado.numero_wa}</div>
                            </div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                {/* Etiqueta producto */}
                                {(() => {
                                    const prod = detectarProducto(seleccionado);
                                    const pi   = prod ? PRODUCTOS_INFO[prod] : null;
                                    return pi ? (
                                        <span style={{ padding: '4px 12px', background: pi.color + '20', color: pi.color, borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
                                            {pi.icon} {pi.label}
                                        </span>
                                    ) : null;
                                })()}
                                {/* Etiqueta estado */}
                                <span style={{ padding: '4px 12px', background: (ESTADOS[seleccionado.estado]?.color || '#888') + '20', color: ESTADOS[seleccionado.estado]?.color || '#888', borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
                                    {ESTADOS[seleccionado.estado]?.icon} {ESTADOS[seleccionado.estado]?.label || seleccionado.estado}
                                </span>
                                {/* Email si lo dio */}
                                {seleccionado.email_cliente && (
                                    <span style={{ fontSize: 12, color: '#888' }}>✉️ {seleccionado.email_cliente}</span>
                                )}
                            </div>
                        </div>

                        {/* Historial */}
                        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 8, background: '#f8f9fa' }}>
                            {(!seleccionado.historial || seleccionado.historial.length === 0) && (
                                <div style={{ textAlign: 'center', color: '#aaa', padding: 24 }}>Sin historial de mensajes</div>
                            )}
                            {(seleccionado.historial || []).map((h, i) => (
                                <div key={i} style={{ display: 'flex', justifyContent: h.rol === 'bot' ? 'flex-start' : 'flex-end' }}>
                                    <div style={{
                                        maxWidth: '75%', padding: '10px 14px',
                                        borderRadius: h.rol === 'bot' ? '4px 16px 16px 16px' : '16px 4px 16px 16px',
                                        background: h.rol === 'bot' ? '#fff' : '#25d366',
                                        color: h.rol === 'bot' ? '#1a1a2e' : '#fff',
                                        fontSize: 13.5, boxShadow: '0 1px 4px rgba(0,0,0,.08)',
                                        whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                                    }}>
                                        {h.texto}
                                        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4, textAlign: 'right' }}>
                                            {h.ts ? new Date(h.ts).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : ''}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
