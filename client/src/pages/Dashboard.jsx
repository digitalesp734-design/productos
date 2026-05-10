import React, { useEffect, useState } from 'react';
import { api } from '../App';

const fmt = n => `$${parseInt(n || 0).toLocaleString('es-CO')}`;

function Card({ emoji, label, value, color }) {
    return (
        <div style={{ background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,.06)', borderLeft: `4px solid ${color}` }}>
            <div style={{ fontSize: 28 }}>{emoji}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color, margin: '8px 0 4px' }}>{value}</div>
            <div style={{ color: '#888', fontSize: 14 }}>{label}</div>
        </div>
    );
}

export default function Dashboard() {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api('/dashboard').then(d => {
            if (d.ok) setData(d);
            else setError(d.msg || 'Error cargando dashboard');
        });
    }, []);

    if (error) return <div style={{ padding: 40, color: '#e74c3c', background: '#fff', borderRadius: 12, margin: 24 }}>⚠️ {error}</div>;
    if (!data) return <div style={{ padding: 40, color: '#888' }}>Cargando...</div>;

    return (
        <div>
            <h2 style={{ marginBottom: 24, fontSize: 24, fontWeight: 800 }}>📊 Dashboard</h2>

            <h3 style={{ marginBottom: 12, color: '#888', fontWeight: 600 }}>HOY</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 16, marginBottom: 32 }}>
                <Card emoji="💰" label="Ingresos hoy"    value={fmt(data.hoy.ingresos)}  color="#25d366" />
                <Card emoji="🛒" label="Ventas hoy"      value={data.hoy.ventas}          color="#3498db" />
                <Card emoji="💬" label="Chats hoy"       value={data.chats_hoy}           color="#9b59b6" />
                <Card emoji="⏳" label="Pendientes"       value={data.pendientes}          color="#f39c12" />
            </div>

            <h3 style={{ marginBottom: 12, color: '#888', fontWeight: 600 }}>ESTE MES</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 16, marginBottom: 32 }}>
                <Card emoji="📈" label="Ingresos del mes" value={fmt(data.mes.ingresos)} color="#e67e22" />
                <Card emoji="📦" label="Ventas del mes"   value={data.mes.ventas}         color="#e74c3c" />
                <Card emoji="👥" label="Chats totales"    value={data.chats_total}        color="#1abc9c" />
            </div>

            {data.top_productos?.length > 0 && (
                <>
                    <h3 style={{ marginBottom: 12, color: '#888', fontWeight: 600 }}>TOP PRODUCTOS</h3>
                    <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
                        {data.top_productos.map((p, i) => (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: i < data.top_productos.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                                <div><span style={{ fontWeight: 700, color: '#25d366', marginRight: 8 }}>#{i + 1}</span>{p.nombre}</div>
                                <div style={{ display: 'flex', gap: 16 }}>
                                    <span style={{ color: '#888', fontSize: 13 }}>{p.ventas} venta{p.ventas !== 1 ? 's' : ''}</span>
                                    <span style={{ fontWeight: 700, color: '#1a1a2e' }}>{fmt(p.total)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
