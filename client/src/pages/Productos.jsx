import React, { useEffect, useState } from 'react';
import { api } from '../App';

const fmt = n => `$${parseInt(n || 0).toLocaleString('es-CO')}`;
const VACIO = { nombre: '', descripcion: '', precio: '', link_drive: '', imagen_url: '', orden: 0, activo: true };

export default function Productos() {
    const [productos, setProductos] = useState([]);
    const [form, setForm] = useState(VACIO);
    const [editId, setEditId] = useState(null);
    const [msg, setMsg] = useState('');
    const [mostrarForm, setMostrarForm] = useState(false);

    const cargar = () => api('/productos').then(d => d.ok && setProductos(d.productos));
    useEffect(() => { cargar(); }, []);

    const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

    const guardar = async e => {
        e.preventDefault();
        setMsg('');
        const data = editId
            ? await api(`/productos/${editId}`, { method: 'PUT', body: JSON.stringify(form) })
            : await api('/productos', { method: 'POST', body: JSON.stringify(form) });
        if (!data.ok) return setMsg(data.msg);
        setForm(VACIO); setEditId(null); setMostrarForm(false); cargar();
    };

    const editar = p => { setForm({ nombre: p.nombre, descripcion: p.descripcion || '', precio: p.precio, link_drive: p.link_drive, imagen_url: p.imagen_url || '', orden: p.orden, activo: p.activo }); setEditId(p.id); setMostrarForm(true); window.scrollTo(0,0); };
    const eliminar = async id => { if (confirm('¿Desactivar este producto?')) { await api(`/productos/${id}`, { method: 'DELETE' }); cargar(); } };

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <h2 style={{ fontSize: 24, fontWeight: 800 }}>📦 Productos</h2>
                <button onClick={() => { setForm(VACIO); setEditId(null); setMostrarForm(!mostrarForm); }}
                    style={{ padding: '10px 20px', background: '#25d366', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700 }}>
                    {mostrarForm ? '✕ Cancelar' : '+ Nuevo producto'}
                </button>
            </div>

            {mostrarForm && (
                <div style={{ background: '#fff', borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
                    <h3 style={{ marginBottom: 16 }}>{editId ? 'Editar producto' : 'Nuevo producto'}</h3>
                    <form onSubmit={guardar}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                            {[['nombre','Nombre del producto'],['precio','Precio (COP)']].map(([k,l]) => (
                                <div key={k}>
                                    <label style={{ fontSize: 13, color: '#666', display: 'block', marginBottom: 4 }}>{l}</label>
                                    <input value={form[k]} onChange={e => set(k, e.target.value)} required={k !== 'imagen_url'}
                                        type={k === 'precio' ? 'number' : 'text'}
                                        style={{ width: '100%', padding: '10px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14 }} />
                                </div>
                            ))}
                        </div>
                        {[['link_drive','Link de Google Drive (acceso al producto)'],['imagen_url','URL imagen (opcional)']].map(([k,l]) => (
                            <div key={k} style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 13, color: '#666', display: 'block', marginBottom: 4 }}>{l}</label>
                                <input value={form[k]} onChange={e => set(k, e.target.value)} required={k === 'link_drive'}
                                    style={{ width: '100%', padding: '10px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14 }} />
                            </div>
                        ))}
                        <div style={{ marginBottom: 16 }}>
                            <label style={{ fontSize: 13, color: '#666', display: 'block', marginBottom: 4 }}>Descripción</label>
                            <textarea value={form.descripcion} onChange={e => set('descripcion', e.target.value)} rows={4}
                                style={{ width: '100%', padding: '10px 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 14, resize: 'vertical' }} />
                        </div>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                            <div>
                                <label style={{ fontSize: 13, color: '#666', marginRight: 8 }}>Orden:</label>
                                <input type="number" value={form.orden} onChange={e => set('orden', e.target.value)} style={{ width: 70, padding: '8px 10px', border: '2px solid #e8e8e8', borderRadius: 8 }} />
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, cursor: 'pointer' }}>
                                <input type="checkbox" checked={form.activo} onChange={e => set('activo', e.target.checked)} />
                                Activo
                            </label>
                        </div>
                        {msg && <div style={{ color: '#e74c3c', marginTop: 8 }}>{msg}</div>}
                        <button type="submit" style={{ marginTop: 16, padding: '12px 28px', background: '#25d366', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15 }}>
                            {editId ? 'Guardar cambios' : 'Crear producto'}
                        </button>
                    </form>
                </div>
            )}

            <div style={{ display: 'grid', gap: 12 }}>
                {productos.map(p => (
                    <div key={p.id} style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: p.activo ? 1 : 0.5 }}>
                        <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontWeight: 700, fontSize: 16 }}>#{p.orden} {p.nombre}</span>
                                {!p.activo && <span style={{ background: '#f0f0f0', color: '#888', fontSize: 11, padding: '2px 8px', borderRadius: 10 }}>INACTIVO</span>}
                            </div>
                            <div style={{ color: '#25d366', fontWeight: 700, marginTop: 4 }}>{fmt(p.precio)}</div>
                            <div style={{ color: '#888', fontSize: 13, marginTop: 2 }}>{p.descripcion?.slice(0, 80)}{p.descripcion?.length > 80 ? '...' : ''}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => editar(p)} style={{ padding: '8px 16px', background: '#3498db', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600 }}>Editar</button>
                            <button onClick={() => eliminar(p.id)} style={{ padding: '8px 16px', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600 }}>Desactivar</button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
