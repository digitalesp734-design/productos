import React, { useEffect, useState } from 'react';
import { api } from '../App';

const ESTADOS = {
    nuevo:                 { label: 'Nuevo',       color: '#3498db' },
    menu:                  { label: 'Viendo menú', color: '#9b59b6' },
    viendo_producto:       { label: 'Interesado',  color: '#f39c12' },
    esperando_comprobante: { label: 'Esperando pago', color: '#e67e22' },
    completado:            { label: 'Compró ✅',   color: '#25d366' },
};

function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h}h`;
    return `hace ${Math.floor(h / 24)}d`;
}

export default function Chats() {
    const [chats, setChats] = useState([]);
    const [seleccionado, setSeleccionado] = useState(null);
    const [busqueda, setBusqueda] = useState('');

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

    const filtrados = chats;

    return (
        <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 48px)' }}>
            {/* Lista de chats */}
            <div style={{ width: 340, display: 'flex', flexDirection: 'column', gap: 0 }}>
                <div style={{ marginBottom: 12 }}>
                    <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>💬 Chats</h2>
                    <input
                        value={busqueda} onChange={e => setBusqueda(e.target.value)}
                        placeholder="Buscar por número o nombre..."
                        style={{ width: '100%', padding: '10px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14 }}
                    />
                </div>
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {filtrados.length === 0 && (
                        <div style={{ textAlign: 'center', padding: 40, color: '#888', fontSize: 14 }}>
                            No hay chats aún.<br />Llegarán cuando alguien escriba por WhatsApp.
                        </div>
                    )}
                    {filtrados.map(c => {
                        const est = ESTADOS[c.estado] || ESTADOS.nuevo;
                        const activo = seleccionado?.id === c.id;
                        return (
                            <div key={c.id} onClick={() => verDetalle(c)}
                                style={{ background: activo ? '#f0fdf4' : '#fff', border: `2px solid ${activo ? '#25d366' : '#f0f0f0'}`, borderRadius: 12, padding: '12px 14px', cursor: 'pointer', transition: 'all .15s' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <div style={{ fontWeight: 700, fontSize: 14 }}>{c.nombre_cliente || c.numero_wa}</div>
                                    <div style={{ fontSize: 11, color: '#aaa' }}>{timeAgo(c.updatedAt)}</div>
                                </div>
                                <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>📱 {c.numero_wa}</div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                                    <div style={{ color: '#666', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {c.ultimo_mensaje || '—'}
                                    </div>
                                    <span style={{ marginLeft: 8, padding: '2px 8px', background: est.color + '20', color: est.color, borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                                        {est.label}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Detalle del chat */}
            <div style={{ flex: 1, background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,.06)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {!seleccionado ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aaa', fontSize: 15 }}>
                        Selecciona un chat para ver el historial
                    </div>
                ) : (
                    <>
                        {/* Header */}
                        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <div style={{ fontWeight: 700, fontSize: 16 }}>{seleccionado.nombre_cliente || seleccionado.numero_wa}</div>
                                <div style={{ color: '#888', fontSize: 13 }}>📱 {seleccionado.numero_wa}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                {seleccionado.producto && (
                                    <div style={{ fontSize: 13, color: '#25d366', fontWeight: 600 }}>🛒 {seleccionado.producto.nombre}</div>
                                )}
                                <span style={{ padding: '3px 10px', background: (ESTADOS[seleccionado.estado]?.color || '#888') + '20', color: ESTADOS[seleccionado.estado]?.color || '#888', borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
                                    {ESTADOS[seleccionado.estado]?.label || seleccionado.estado}
                                </span>
                            </div>
                        </div>

                        {/* Historial de mensajes */}
                        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 8, background: '#f8f9fa' }}>
                            {(!seleccionado.historial || seleccionado.historial.length === 0) && (
                                <div style={{ textAlign: 'center', color: '#aaa', padding: 24 }}>Sin historial de mensajes</div>
                            )}
                            {(seleccionado.historial || []).map((h, i) => (
                                <div key={i} style={{ display: 'flex', justifyContent: h.rol === 'bot' ? 'flex-start' : 'flex-end' }}>
                                    <div style={{
                                        maxWidth: '75%', padding: '10px 14px', borderRadius: h.rol === 'bot' ? '4px 16px 16px 16px' : '16px 4px 16px 16px',
                                        background: h.rol === 'bot' ? '#fff' : '#25d366',
                                        color: h.rol === 'bot' ? '#1a1a2e' : '#fff',
                                        fontSize: 14, boxShadow: '0 1px 4px rgba(0,0,0,.08)',
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
