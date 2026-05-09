import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, api } from '../App';

export default function Login() {
    const { login } = useAuth();
    const nav = useNavigate();
    const [form, setForm] = useState({ email: '', password: '' });
    const [msg, setMsg] = useState('');
    const [loading, setLoading] = useState(false);

    const submit = async e => {
        e.preventDefault();
        setLoading(true); setMsg('');
        const data = await api('/auth/login', { method: 'POST', body: JSON.stringify(form) });
        setLoading(false);
        if (data.ok) { login(data.token, data.user); nav('/dashboard'); }
        else setMsg(data.msg || 'Error');
    };

    return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#1a1a2e,#16213e)' }}>
            <div style={{ background: '#fff', borderRadius: 16, padding: 40, width: 360, boxShadow: '0 20px 60px rgba(0,0,0,.3)' }}>
                <div style={{ textAlign: 'center', marginBottom: 32 }}>
                    <div style={{ fontSize: 48 }}>🛒</div>
                    <h1 style={{ fontSize: 24, fontWeight: 800, color: '#1a1a2e' }}>Product Digital</h1>
                    <p style={{ color: '#888', marginTop: 4 }}>Panel de Administración</p>
                </div>
                <form onSubmit={submit}>
                    {['email','password'].map(f => (
                        <input key={f} type={f} placeholder={f === 'email' ? 'Correo electrónico' : 'Contraseña'}
                            value={form[f]} onChange={e => setForm(p => ({ ...p, [f]: e.target.value }))} required
                            style={{ display: 'block', width: '100%', padding: '12px 16px', margin: '0 0 12px', border: '2px solid #e8e8e8', borderRadius: 8, fontSize: 15 }} />
                    ))}
                    {msg && <div style={{ color: '#e74c3c', marginBottom: 12, fontSize: 14 }}>{msg}</div>}
                    <button type="submit" disabled={loading}
                        style={{ width: '100%', padding: '13px', background: '#25d366', color: '#fff', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 700 }}>
                        {loading ? 'Ingresando...' : 'Ingresar'}
                    </button>
                </form>
            </div>
        </div>
    );
}
