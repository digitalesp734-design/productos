import { useEffect, useState } from 'react';
import { api } from '../App';

const STATUS_LABEL = {
    ready:        { text: 'Conectado ✅', color: '#22c55e' },
    qr:           { text: 'Esperando escaneo 📱', color: '#f59e0b' },
    disconnected: { text: 'Desconectado ❌', color: '#ef4444' },
};

export default function WhatsApp() {
    const [data, setData] = useState({ status: 'disconnected', qrImage: null });
    const [loading, setLoading] = useState(true);

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

    const info = STATUS_LABEL[data.status] || STATUS_LABEL.disconnected;

    return (
        <div style={{ padding: '2rem', maxWidth: 500, margin: '0 auto' }}>
            <h2 style={{ marginBottom: '1.5rem' }}>WhatsApp Bot</h2>

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

                {data.status === 'qr' && data.qrImage && (
                    <div>
                        <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>
                            Abre WhatsApp en tu celular → Dispositivos vinculados → Vincular dispositivo → Escanea este QR
                        </p>
                        <img
                            src={data.qrImage}
                            alt="QR WhatsApp"
                            style={{ width: 220, height: 220, borderRadius: 8, background: 'white', padding: 8 }}
                        />
                        <p style={{ color: '#64748b', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                            Se actualiza automáticamente
                        </p>
                    </div>
                )}

                {data.status === 'ready' && (
                    <div style={{ color: '#94a3b8' }}>
                        <p>El bot está activo y respondiendo mensajes.</p>
                        <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                            Los chats aparecen en la sección <strong>Chats</strong>.
                        </p>
                    </div>
                )}

                {data.status === 'disconnected' && !loading && (
                    <p style={{ color: '#94a3b8' }}>
                        El servidor está iniciando WhatsApp. Espera unos segundos y el QR aparecerá aquí.
                    </p>
                )}
            </div>

            <div style={{ background: '#1e293b', borderRadius: 12, padding: '1.5rem' }}>
                <h3 style={{ marginBottom: '0.75rem', fontSize: '0.95rem' }}>Instrucciones</h3>
                <ol style={{ color: '#94a3b8', fontSize: '0.88rem', lineHeight: 1.7, paddingLeft: '1.2rem' }}>
                    <li>Inicia el servidor local</li>
                    <li>Espera que aparezca el QR arriba</li>
                    <li>Abre WhatsApp en tu celular</li>
                    <li>Ve a <strong>Dispositivos vinculados → Vincular dispositivo</strong></li>
                    <li>Escanea el QR</li>
                    <li>El bot queda activo en tu número personal</li>
                </ol>
            </div>
        </div>
    );
}
