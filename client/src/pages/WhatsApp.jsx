import { useEffect, useState } from 'react';
import { api } from '../App';

const STATUS_LABEL = {
    ready:        { text: 'Conectado ✅', color: '#22c55e' },
    qr:           { text: 'Esperando escaneo 📱', color: '#f59e0b' },
    disconnected: { text: 'Desconectado ❌', color: '#ef4444' },
};

export default function WhatsApp() {
    const [data, setData]         = useState({ status: 'disconnected', qrImage: null });
    const [loading, setLoading]   = useState(true);
    const [restarting, setRestarting] = useState(false);
    const [msg, setMsg]           = useState('');

    const fetchStatus = async () => {
        const r = await api('/wa/status');
        if (r.ok) setData(r);
        setLoading(false);
    };

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 4000);
        return () => clearInterval(interval);
    }, []);

    const handleRestart = async () => {
        setRestarting(true);
        setMsg('');
        try {
            const r = await api('/wa/restart', { method: 'POST' });
            setMsg(r.mensaje || 'Reiniciando...');
        } catch {
            setMsg('Error al reiniciar');
        }
        // Esperar 5 seg y volver a consultar
        setTimeout(() => {
            setRestarting(false);
            fetchStatus();
        }, 5000);
    };

    const info = STATUS_LABEL[data.status] || STATUS_LABEL.disconnected;

    return (
        <div style={{ padding: '2rem', maxWidth: 520, margin: '0 auto' }}>
            <h2 style={{ marginBottom: '1.5rem' }}>WhatsApp Bot</h2>

            {/* Estado */}
            <div style={{
                background: '#1e293b', borderRadius: 12, padding: '1.5rem',
                marginBottom: '1.5rem', textAlign: 'center'
            }}>
                <div style={{
                    display: 'inline-block', background: info.color + '22',
                    border: `2px solid ${info.color}`, borderRadius: 8,
                    padding: '0.5rem 1.5rem', color: info.color,
                    fontWeight: 600, fontSize: '1.1rem', marginBottom: '1rem'
                }}>
                    {info.text}
                </div>

                {loading && <p style={{ color: '#94a3b8' }}>Cargando...</p>}

                {/* QR listo para escanear */}
                {data.status === 'qr' && data.qrImage && (
                    <div>
                        <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>
                            WhatsApp → Dispositivos vinculados → Vincular dispositivo → Escanea
                        </p>
                        <img
                            src={data.qrImage}
                            alt="QR WhatsApp"
                            style={{ width: 220, height: 220, borderRadius: 8, background: 'white', padding: 8 }}
                        />
                        <p style={{ color: '#64748b', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                            Se actualiza automáticamente cada 4 segundos
                        </p>
                    </div>
                )}

                {/* Conectado */}
                {data.status === 'ready' && (
                    <div style={{ color: '#94a3b8' }}>
                        <p>El bot está activo y respondiendo mensajes.</p>
                        <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                            Los chats aparecen en la sección <strong>Chats</strong>.
                        </p>
                    </div>
                )}

                {/* Desconectado */}
                {data.status === 'disconnected' && !loading && (
                    <p style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>
                        La sesión de WhatsApp está cerrada. Haz clic en <strong>Regenerar QR</strong> para reconectar.
                    </p>
                )}

                {/* Generando */}
                {restarting && (
                    <p style={{ color: '#f59e0b', marginTop: '0.5rem' }}>
                        ⏳ Generando nuevo QR, espera unos segundos...
                    </p>
                )}
                {msg && !restarting && (
                    <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: '0.5rem' }}>{msg}</p>
                )}
            </div>

            {/* Botón regenerar QR */}
            {data.status !== 'ready' && (
                <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                    <button
                        onClick={handleRestart}
                        disabled={restarting}
                        style={{
                            background: restarting ? '#334155' : '#5A00B8',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 8,
                            padding: '0.75rem 2rem',
                            fontSize: '1rem',
                            fontWeight: 600,
                            cursor: restarting ? 'not-allowed' : 'pointer',
                            transition: 'background 0.2s',
                            width: '100%',
                        }}
                    >
                        {restarting ? '⏳ Reiniciando...' : '🔄 Regenerar QR'}
                    </button>
                </div>
            )}

            {/* Instrucciones */}
            <div style={{ background: '#1e293b', borderRadius: 12, padding: '1.5rem' }}>
                <h3 style={{ marginBottom: '0.75rem', fontSize: '0.95rem' }}>Cómo conectar</h3>
                <ol style={{ color: '#94a3b8', fontSize: '0.88rem', lineHeight: 1.8, paddingLeft: '1.2rem' }}>
                    <li>Haz clic en <strong>Regenerar QR</strong></li>
                    <li>Espera 5-10 segundos hasta que aparezca el QR</li>
                    <li>Abre WhatsApp en tu celular</li>
                    <li>Ve a <strong>Dispositivos vinculados → Vincular dispositivo</strong></li>
                    <li>Escanea el QR — el bot queda activo</li>
                </ol>
                <p style={{ color: '#475569', fontSize: '0.8rem', marginTop: '1rem' }}>
                    Si el QR expira antes de escanearlo, vuelve a hacer clic en Regenerar QR.
                </p>
            </div>
        </div>
    );
}
