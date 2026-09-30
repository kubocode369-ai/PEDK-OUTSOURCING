/**
 * RESTABLECER EL PIN DE ADMINISTRADOR, como hace Xerox: si el técnico del cliente se
 * va y nadie sabe el PIN, el cliente NO puede hacerlo solo; tiene que llamar a Soprint.
 *
 *  1. En la pantalla del PIN de admin: "¿Olvidó el PIN?".
 *  2. El panel enseña la SERIE del equipo y una SOLICITUD de 6 cifras al azar.
 *  3. Soprint calcula la respuesta de 6 cifras con su generador (una página que se abre
 *     con doble clic, ver herramientas/hacer-generador.mjs). La cuenta: codigoRescate.js.
 *  4. Con la respuesta buena el PIN de admin vuelve al de fábrica. NADA MÁS cambia:
 *     ni usuarios, ni contadores, ni ajustes, ni el bloqueo.
 *
 * Una respuesta sólo vale para ese equipo y esa solicitud, y la solicitud se cambia en
 * cuanto se usa o tras INTENTOS_MAX fallos (y entonces hay que esperar). Sólo existe
 * en el panel, nunca en la web: hay que estar delante de la máquina.
 *
 * La clave NO está en el repositorio: vite la mete al compilar desde sign/rescate.key
 * (ver vite.config.js). Sin clave, el botón no aparece.
 *
 * La serie se lee con ProductInfo.getProductSerialNumber() (medido el 30-09-2026 en la
 * BM5220ADW: "CV3DV0004X", igual que la etiqueta).
 */
import { config } from './config.js';
import { COLOR, ambito, boton, etiqueta, pantalla, recortar, tecladoNumerico } from './ui.js';
import { mostrar, repintar } from './router.js';
import { CIFRAS_CODIGO, enGrupos, respuesta } from './codigoRescate.js';
import * as store from './store.js';

/** La solicitud en curso. Vive mientras viva la app: un reinicio da otra. */
let solicitudActual = null;
let fallos = 0;
let esperaHasta = 0;

let escrito = '';
let mensaje = '';
let colorMensaje = COLOR.suave;
let alVolver = null;

function clave() {
    // eslint-disable-next-line no-undef
    const k = typeof __CLAVE_RESCATE__ !== 'undefined' ? __CLAVE_RESCATE__ : globalThis.__CLAVE_RESCATE__;
    return typeof k === 'string' && k.length >= 16 ? k : null;
}

/** Sin clave compilada no hay a quién llamar: el botón no sale. */
export function disponible() {
    return clave() !== null;
}

/** Serie del equipo en mayúsculas, o '?' si el firmware no la da. */
export function serie() {
    try {
        const P = pedk.device.setting.ProductInfo;
        const s = new P().getProductSerialNumber();
        // Con alguna cifra: los errores del firmware (EINVALIDPARAM…) también son texto.
        if (typeof s === 'string' && /^[A-Za-z0-9-]{4,32}$/.test(s) && /\d/.test(s)) {
            return s.toUpperCase();
        }
        console.log('[rescate] serie rara: ' + JSON.stringify(s));
    } catch (e) {
        console.log('[rescate] no se pudo leer la serie: ' + (e && e.message));
    }
    return '?';
}

export { respuesta };

function nuevaSolicitud() {
    let s = '';
    for (let i = 0; i < CIFRAS_CODIGO; i++) {
        s += String(Math.floor(Math.random() * 10));
    }
    solicitudActual = s.charAt(0) === '0' ? '1' + s.slice(1) : s;
    fallos = 0;
    return solicitudActual;
}

export function solicitud() {
    return solicitudActual || nuevaSolicitud();
}

/**
 * Comprueba la respuesta. Con la buena, PIN de admin de fábrica y solicitud nueva.
 * @returns {{ok: boolean, error?: string}}
 */
export function comprobar(codigo, ahora) {
    const t = ahora === undefined ? Date.now() : ahora;
    const k = clave();
    if (!k) {
        return { ok: false, error: 'Este equipo no tiene restablecimiento' };
    }
    if (t < esperaHasta) {
        return { ok: false, error: 'Demasiados intentos: espere ' + Math.ceil((esperaHasta - t) / 60000) + ' min' };
    }
    const s = serie();
    const sol = solicitud();
    if (String(codigo) === respuesta(k, s, sol)) {
        store.restablecerPinAdmin();
        console.log('[rescate] PIN de admin restablecido · serie ' + s + ' · solicitud ' + sol);
        nuevaSolicitud();
        return { ok: true };
    }
    fallos++;
    console.log('[rescate] código incorrecto (' + fallos + '/' + config.INTENTOS_MAX + ')');
    if (fallos >= config.INTENTOS_MAX) {
        esperaHasta = t + config.BLOQUEO_INTENTOS_MS;
        nuevaSolicitud();
        return { ok: false, error: 'Demasiados intentos: solicitud anulada, espere' };
    }
    return { ok: false, error: 'Código incorrecto' };
}

/* ------------------------------------------------------------------ */
/* Pantalla                                                             */
/* ------------------------------------------------------------------ */

/** @param {(aviso: ?string) => void} volver  se le pasa el aviso si se restableció */
export function abrirRescate(volver) {
    alVolver = volver;
    escrito = '';
    mensaje = '';
    colorMensaje = COLOR.suave;
    solicitud();
    mostrar('rescate', render);
}

function tecla(t) {
    if (t === 'C') {
        escrito = '';
        mensaje = '';
    } else if (t !== 'OK') {
        if (escrito.length < CIFRAS_CODIGO) {
            escrito += t;
        }
    } else {
        const r = comprobar(escrito);
        escrito = '';
        if (r.ok) {
            alVolver && alVolver('PIN restablecido a ' + config.PIN_ADMIN_FABRICA + ': entre y cámbielo');
            return;
        }
        mensaje = r.error;
        colorMensaje = COLOR.peligro;
    }
    repintar();
}

function render() {
    ambito('rsc');
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 456, 22, 'Restablecer PIN de administrador', COLOR.texto, 'center'));
    w.push(etiqueta('l1', 12, 44, 160, 20, 'Llame a Soprint', COLOR.texto));
    w.push(etiqueta('l2', 12, 64, 160, 20, 'y dé estos datos:', COLOR.suave));
    w.push(etiqueta('ls', 12, 96, 160, 20, 'Serie', COLOR.suave));
    w.push(etiqueta('vs', 12, 116, 160, 24, serie(), COLOR.acento));
    w.push(etiqueta('lq', 12, 148, 160, 20, 'Solicitud', COLOR.suave));
    w.push(etiqueta('vq', 12, 168, 160, 24, enGrupos(solicitud()), COLOR.acento));
    w.push(...tecladoNumerico('np', 178, 40, tecla));
    w.push(etiqueta('lc', 12, 214, 160, 22, 'Código de Soprint:', COLOR.texto));
    w.push(etiqueta('vc', 178, 214, 290, 22, escrito ? enGrupos(escrito) : '_', COLOR.acento, 'center'));
    w.push(etiqueta('msg', 12, 248, 456, 22, recortar(mensaje, 62), colorMensaje, 'center'));
    w.push(boton('volver', 12, 282, 110, 32, 'Volver', COLOR.suave, () => alVolver && alVolver(null)));
    return w;
}
