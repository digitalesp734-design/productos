import React, { useEffect, useState } from 'react';
import { api } from '../App';

const fmt = n => `$${parseInt(n || 0).toLocaleString('es-CO')}`;
const hoyStr = () => new Date().toISOString().slice(0, 10);
const ESTADOS = { completada: { label: 'Completada', color: '#25d366' }, pendiente: { label: 'Pendiente', color: '#f39c12' }, rechazada: { label: 'Rechazada', color: '#e74c3c' } };

export default function Ventas() {
    const [ventas, setVentas] = useState([]);
    const [fecha, setFecha] = useState(hoyStr());
    const [filtroEstado, setFiltroEstado] = useState('');

    const cargar = () => {
        const params = new URLSearchParams({ fecha });
        if (filtroEstado) params.set('estado', filtroEstado);
        api(`/ventas?${params}`).then(d => d.ok && setVentas(d.ventas));
    };

    useEffect(() => { cargar(); }, [fecha, filtroEstado]);

    const total = ventas.filter(v => v.estado === 'completada').reduce((s, v) => s + v.monto, 0);

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <h2 style={{ fontSize: 24, fontWeight: 800 }}>💰 Ventas</h2>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
                        style={{ padding: '8px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14 }} />
                    <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
                        style={{ padding: '8px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14 }}>
                        <option value="">Todos</option>
                        {Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                </div>
            </div>

            <div style={{ background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: '0 2px 8px rgba(0,0,0,.06)', display: 'flex', gap: 32 }}>
                <div><span style={{ color: '#888', fontSize: 13 }}>Total ventas: </span><strong>{ventas.length}</strong></div>
                <div><span style={{ color: '#888', fontSize: 13 }}>Ingresos confirmados: </span><strong style={{ color: '#25d366' }}>{fmt(total)}</strong></div>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
                {ventas.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>No hay ventas para esta fecha</div>}
                {ventas.map(v => {
                    const est = ESTADOS[v.estado] || ESTADOS.pendiente;
                    return (
                        <div key={v.id} style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,.06)', borderLeft: `4px solid ${est.color}` }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: 15 }}>{v.nombre_cliente || v.numero_wa}</div>
                                    <div style={{ color: '#888', fontSize: 13 }}>📱 {v.numero_wa}</div>
                                    <div style={{ marginTop: 6, fontWeight: 700, color: '#1a1a2e' }}>{v.producto?.nombre}</div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontWeight: 800, fontSize: 20, color: '#25d366' }}>{fmt(v.monto)}</div>
                                    <span style={{ display: 'inline-block', marginTop: 4, padding: '3px 10px', background: est.color + '20', color: est.color, borderRadius: 20, fontSize: 12, fontWeight: 700 }}>{est.label}</span>
                                </div>
                            </div>
                            {v.comprobante_url && (
                                <div style={{ marginTop: 10 }}>
                                    <a href={v.comprobante_url} target="_blank" rel="noreferrer"
                                        style={{ color: '#3498db', fontSize: 13 }}>📎 Ver comprobante</a>
                                </div>
                            )}
                            {v.link_enviado && (
                                <div style={{ marginTop: 4 }}>
                                    <a href={v.link_enviado} target="_blank" rel="noreferrer"
                                        style={{ color: '#25d366', fontSize: 13 }}>🔗 Link enviado al cliente</a>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
