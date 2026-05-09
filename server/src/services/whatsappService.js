const TOKEN    = () => process.env.WHATSAPP_TOKEN;
const PHONE_ID = () => process.env.WHATSAPP_PHONE_ID;
const BASE     = 'https://graph.facebook.com/v21.0';

async function enviarTexto(numero, texto) {
    const r = await fetch(`${BASE}/${PHONE_ID()}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN()}` },
        body: JSON.stringify({
            messaging_product: 'whatsapp', to: numero,
            type: 'text', text: { body: texto, preview_url: false }
        })
    });
    const data = await r.json();
    if (data.error) console.error('WA error:', data.error.message);
    return data;
}

async function enviarImagen(numero, imageUrl, caption = '') {
    const r = await fetch(`${BASE}/${PHONE_ID()}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN()}` },
        body: JSON.stringify({
            messaging_product: 'whatsapp', to: numero,
            type: 'image', image: { link: imageUrl, caption }
        })
    });
    const data = await r.json();
    if (data.error) console.error('WA imagen error:', data.error.message);
    return data;
}

async function obtenerUrlMedia(mediaId) {
    const r = await fetch(`${BASE}/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${TOKEN()}` }
    });
    const data = await r.json();
    return data.url || null;
}

async function descargarMedia(mediaId) {
    const url = await obtenerUrlMedia(mediaId);
    if (!url) return null;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${TOKEN()}` } });
    const buffer = Buffer.from(await r.arrayBuffer());
    return { buffer, url };
}

module.exports = { enviarTexto, enviarImagen, descargarMedia, obtenerUrlMedia };
