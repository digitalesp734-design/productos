import React, { createContext, useContext, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import Login     from './pages/Login';
import Dashboard from './pages/Dashboard';
import Productos from './pages/Productos';
import Ventas    from './pages/Ventas';
import Caja      from './pages/Caja';
import Chats     from './pages/Chats';
import WhatsApp  from './pages/WhatsApp';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

const API = '/api';
export const api = async (path, opts = {}) => {
    try {
        const token = localStorage.getItem('pd_token');
        const r = await fetch(`${API}${path}`, {
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers },
            ...opts
        });
        return r.json();
    } catch (e) {
        return { ok: false, msg: 'No se pudo conectar con el servidor' };
    }
};

function AuthProvider({ children }) {
    const [user, setUser] = useState(() => { try { return JSON.parse(localStorage.getItem('pd_user')); } catch { return null; } });

    const login = (token, u) => { localStorage.setItem('pd_token', token); localStorage.setItem('pd_user', JSON.stringify(u)); setUser(u); };
    const logout = () => { localStorage.removeItem('pd_token'); localStorage.removeItem('pd_user'); setUser(null); };

    return <AuthCtx.Provider value={{ user, login, logout }}>{children}</AuthCtx.Provider>;
}

function Layout({ children }) {
    const { user, logout } = useAuth();
    const nav = useNavigate();
    const loc = useLocation();
    const links = [
        { to: '/dashboard', label: '📊 Dashboard' },
        { to: '/chats',     label: '💬 Chats' },
        { to: '/productos', label: '📦 Productos' },
        { to: '/ventas',    label: '💰 Ventas' },
        { to: '/caja',      label: '🏦 Caja' },
        { to: '/whatsapp',  label: '📱 WhatsApp' },
    ];
    return (
        <div style={{ display: 'flex', minHeight: '100vh' }}>
            <aside style={{ width: 220, background: '#1a1a2e', color: '#fff', display: 'flex', flexDirection: 'column', padding: '24px 0' }}>
                <div style={{ padding: '0 20px 24px', borderBottom: '1px solid #333' }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#25d366' }}>🛒 Product Digital</div>
                    <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>{user?.nombre}</div>
                </div>
                <nav style={{ flex: 1, padding: '12px 0' }}>
                    {links.map(l => (
                        <div key={l.to} onClick={() => nav(l.to)}
                            style={{ padding: '12px 20px', cursor: 'pointer', background: loc.pathname === l.to ? '#25d366' : 'transparent',
                                color: loc.pathname === l.to ? '#1a1a2e' : '#ccc', fontWeight: loc.pathname === l.to ? 700 : 400,
                                borderLeft: loc.pathname === l.to ? '3px solid #fff' : '3px solid transparent' }}>
                            {l.label}
                        </div>
                    ))}
                </nav>
                <div onClick={() => { logout(); nav('/login'); }}
                    style={{ padding: '12px 20px', cursor: 'pointer', color: '#ff6b6b', borderTop: '1px solid #333' }}>
                    🚪 Cerrar sesión
                </div>
            </aside>
            <main style={{ flex: 1, padding: 24, overflow: 'auto' }}>{children}</main>
        </div>
    );
}

function Guard({ children }) {
    const { user } = useAuth();
    return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
    return (
        <AuthProvider>
            <BrowserRouter>
                <Routes>
                    <Route path="/login" element={<Login />} />
                    <Route path="/dashboard" element={<Guard><Layout><Dashboard /></Layout></Guard>} />
                    <Route path="/productos" element={<Guard><Layout><Productos /></Layout></Guard>} />
                    <Route path="/ventas"    element={<Guard><Layout><Ventas /></Layout></Guard>} />
                    <Route path="/caja"      element={<Guard><Layout><Caja /></Layout></Guard>} />
                    <Route path="/chats"     element={<Guard><Layout><Chats /></Layout></Guard>} />
                    <Route path="/whatsapp"  element={<Guard><Layout><WhatsApp /></Layout></Guard>} />
                    <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Routes>
            </BrowserRouter>
        </AuthProvider>
    );
}
