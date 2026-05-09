import React, { useEffect, useState } from 'react';
import { api } from '../App';

const fmt = n => `$${parseInt(n || 0).toLocaleString('es-CO')}`;
const hoyStr = () => new Date().toISOString().slice(0, 10);

export default function Caja() {
    const [resumen, setResumen] = useState(null);
    const [movimientos, setMovimientos] = useState([]);
    const [fecha, setFecha] = useState(hoyStr());
    const [form, setForm] = useState({ tipo: 'egreso', concepto: '', monto: '' });
    const [msg, setMsg] = useState('');
    const [mostrarForm, setMostrarForm] = useState(false);

    const cargar = () => {
        api(`/caja/resumen?fecha=${fecha}`).then(d => {
            if (d.ok) { setResumen(d.resumen); setMovimientos(d.movimientos); }
        });
    };

    useEffect(() => { cargar(); }, [fecha]);

    const guardar = async e => {
        e.preventDefault();
        setMsg('');
        const data = await api('/caja/movimiento', { method: 'POST', body: JSON.stringify({ ...form, fecha }) });
        if (!data.ok) return setMsg(data.msg || 'Error al guardar');
        setForm({ tipo: 'egreso', concepto: '', monto: '' });
        setMostrarForm(false);
        cargar();
    };

    const neto = resumen ? resumen.ingresos - resumen.egresos : 0;

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <h2 style={{ fontSize: 24, fontWeight: 800 }}>🏦 Caja</h2>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
                        style={{ padding: '8px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14 }} />
                    <button onClick={() => setMostrarForm(!mostrarForm)}
                        style={{ padding: '10px 20px', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700 }}>
                        {mostrarForm ? '✕ Cancelar' : '+ Registrar egreso'}
                    </button>
                </div>
            </div>

            {mostrarForm && (
                <div style={{ background: '#fff', borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
                    <h3 style={{ marginBottom: 16 }}>Nuevo movimiento</h3>
                    <form onSubmit={guardar}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
                            <div>
                                <label style={{ fontSize: 13, color: '#666', display: 'block', marginBottom: 4 }}>Tipo</label>
                                <select value={form.tipo} onChange={e => setForm(p => ({ ...p, tipo: e.target.value }))}
                                    style={{ width: '100%', padding: '10px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14 }}>
                                    <option value="egreso">Egreso</option>
                                    <option value="ingreso">Ingreso manual</option>
                                </select>
                            </div>
                            <div>
                                <label style={{ fontSize: 13, color: '#666', display: 'block', marginBottom: 4 }}>Monto (COP)</label>
                                <input type="number" value={form.monto} onChange={e => setForm(p => ({ ...p, monto: e.target.value }))} required
                                    style={{ width: '100%', padding: '10px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14 }} />
                            </div>
                            <div>
                                <label style={{ fontSize: 13, color: '#666', display: 'block', marginBottom: 4 }}>Concepto</label>
                                <input value={form.concepto} onChange={e => setForm(p => ({ ...p, concepto: e.target.value }))} required
                                    style={{ width: '100%', padding: '10px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14 }} />
                            </div>
                        </div>
                        {msg && <div style={{ color: '#e74c3c', marginBottom: 8 }}>{msg}</div>}
                        <button type="submit"
                            style={{ padding: '12px 28px', background: '#25d366', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15 }}>
                            Guardar
                        </button>
                    </form>
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
                {[
                    { label: 'Ingresos', value: resumen?.ingresos || 0, color: '#25d366', emoji: '📈' },
                    { label: 'Egresos',  value: resumen?.egresos  || 0, color: '#e74c3c', emoji: '📉' },
                    { label: 'Neto',     value: neto,                   color: neto >= 0 ? '#3498db' : '#e74c3c', emoji: '💼' },
                ].map(c => (
                    <div key={c.label} style={{ background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,.06)', borderLeft: `4px solid ${c.color}` }}>
                        <div style={{ fontSize: 24 }}>{c.emoji}</div>
                        <div style={{ fontSize: 26, fontWeight: 800, color: c.color, margin: '8px 0 4px' }}>{fmt(c.value)}</div>
                        <div style={{ color: '#888', fontSize: 14 }}>{c.label}</div>
                    </div>
                ))}
            </div>

            <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
                <h3 style={{ marginBottom: 16, fontWeight: 700 }}>Movimientos del día</h3>
                {movimientos.length === 0 && (
                    <div style={{ textAlign: 'center', padding: 32, color: '#888' }}>Sin movimientos para esta fecha</div>
                )}
                {movimientos.map((m, i) => (
                    <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: i < movimientos.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                        <div>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{m.concepto}</div>
                            <div style={{ color: '#aaa', fontSize: 12, marginTop: 2 }}>
                                {m.tipo === 'ingreso' ? '📈 Ingreso' : '📉 Egreso'}
                                {m.venta && <span style={{ marginLeft: 8 }}>· Venta #{m.venta.id}</span>}
                            </div>
                        </div>
                        <div style={{ fontWeight: 800, fontSize: 16, color: m.tipo === 'ingreso' ? '#25d366' : '#e74c3c' }}>
                            {m.tipo === 'ingreso' ? '+' : '-'}{fmt(m.monto)}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
