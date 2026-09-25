/**
 * EL CANAL DE ESTADOS DEL EQUIPO: lo que la impresora sabe y el trabajo no cuenta.
 *
 * `pedk.device.status.addOnPushStatusListener(fn)` avisa cada vez que el equipo
 * levanta un estado (`PEDK_SID_*`), y `addOnRemoveStatusListener(fn)` cuando lo
 * retira. Ahí viene lo que a las pantallas de copia y escaneo les faltaba:
 *
 *  - `SCAN_NEXT_PAGE_WAITING`: el equipo está esperando la hoja siguiente. Sin esto
 *    la pantalla decía "Escaneando…" mientras el equipo esperaba, parada para siempre.
 *  - `SCAN_TO_FILE_UDISK_SAVING`, `SCAN_TOFILE_SENDING`: está guardando o enviando.
 *  - `SCAN_OUT_TO_EML_SUCCESS` / `..._CANCEL`: el correo salió, o NO salió. El trabajo
 *    termina en `JBSts_Finish` igual en los dos casos, así que sin este canal la
 *    persona veía "Listo" aunque su documento no hubiera llegado a ninguna parte.
 *  - Los fallos de verdad: sin hojas en el alimentador, tapa abierta, atasco, sin
 *    tóner, sin memoria.
 *
 * Aquí sólo se traduce lo que sirve para la persona que está delante. Todo lo demás
 * (hay decenas de estados) va al log con el prefijo [estado] y no molesta en pantalla.
 */
import { COLOR } from './ui.js';

/**
 * Lo que se le dice a la persona, por identificador exacto.
 * `nivel`: 'ok' (salió bien), 'info' (está pasando), 'malo' (hay que hacer algo).
 */
const MENSAJES = {
    PEDK_SID_I_SCAN_NEXT_PAGE_WAITING: ['Ponga la hoja siguiente, o pulse TERMINAR.', 'info'],
    PEDK_SID_I_SCAN_PUT_PAPER_TO_ADF: ['Ponga las hojas en el alimentador.', 'info'],
    PEDK_SID_I_SCAN_PUT_NEXT_SIDE_CONFIRM_ADF: ['Dé la vuelta a las hojas y confirme.', 'info'],
    PEDK_SID_I_SCAN_TO_FILE_UDISK_SAVING: ['Guardando en la memoria USB…', 'info'],
    // Visto en el equipo el 25-09-2026: éste llega justo al terminar de escribir.
    PEDK_SID_I_SCAN_SAVE_TO_UDISK: ['Guardado en la memoria USB.', 'ok'],
    PEDK_SID_I_SCAN_TOFILE_SENDING: ['Enviando el documento…', 'info'],
    PEDK_SID_I_SCAN_TO_FILE_SENT: ['Documento enviado.', 'ok'],
    PEDK_SID_I_SCAN_OUT_TO_EML_SUCCESS: ['Correo enviado.', 'ok'],
    PEDK_SID_I_SCAN_OUT_TO_UDISK_SUCCESS: ['Guardado en la memoria USB.', 'ok'],
    PEDK_SID_I_SCAN_OUT_TO_FTP_SUCCESS: ['Guardado en la carpeta.', 'ok'],
    PEDK_SID_I_SCAN_OUT_TO_EML_CANCEL: ['NO se pudo enviar el correo.', 'malo'],
    PEDK_SID_I_SCAN_OUT_TO_UDISK_CANCEL: ['NO se pudo guardar en la memoria USB.', 'malo'],
    PEDK_SID_I_SCAN_OUT_TO_FTP_CANCEL: ['NO se pudo guardar en la carpeta.', 'malo'],
    PEDK_SID_I_SCAN_NO_RESOURCE: ['El escáner está ocupado con otra cosa.', 'malo'],
    PEDK_SID_E_SCAN_ADF_PAPER_OUT: ['No hay hojas en el alimentador.', 'malo'],
    PEDK_SID_E_SCAN_ADF_PAPER_MISMATCH: ['Las hojas no son del mismo tamaño.', 'malo'],
    PEDK_SID_E_SCAN_MEMORY_LOW: ['El equipo se quedó sin memoria.', 'malo'],
    /*
     * El nombre engaña: MEDIDO el 25-09-2026, esto es lo que manda el equipo cuando se
     * escanea a USB y NO HAY MEMORIA PUESTA (no sólo cuando está llena). Así que el
     * mensaje cubre los dos casos, que es lo que la persona tiene que mirar.
     */
    PEDK_SID_E_SCAN_TO_FILE_UDISK_SPACE_OVERSIZE: ['No hay memoria USB puesta, o está llena.', 'malo'],
    PEDK_SID_W_INPUT_TRAY2_FEW: ['Queda poco papel en la bandeja.', 'info'],
    PEDK_SID_E_PRINT_TONER_EMPTY_K: ['Sin tóner.', 'malo'],
};

/** Familias enteras: un atasco tiene doce identificadores y todos se dicen igual. */
const FAMILIAS = [
    [/_SCAN_.*COVER_OPEN/, ['Cierre la tapa del escáner.', 'malo']],
    [/_SCAN_PAPER_JAM/, ['Hoja atascada en el escáner.', 'malo']],
    [/_SCAN_PAPER_MISPICK/, ['El alimentador no cogió la hoja.', 'malo']],
    [/_SCAN_COMMUNICATION_ERR/, ['El escáner no responde. Reinicie el equipo.', 'malo']],
    [/COVER_OPEN/, ['Hay una tapa abierta.', 'malo']],
    [/JAM/, ['Papel atascado.', 'malo']],
    [/TONER_EMPTY/, ['Sin tóner.', 'malo']],
    [/TONER_MISSING/, ['Falta el cartucho de tóner.', 'malo']],
];

const COLORES = { ok: COLOR.ok, info: COLOR.texto, malo: COLOR.peligro };
const MAX_RECORDADOS = 12;

/**
 * A QUÉ objeto `pedk.device.status` nos enganchamos. No basta un `true`: si el equipo
 * cambia por debajo (al reinstalar, o en las pruebas), los avisos seguirían yendo al
 * objeto viejo y la pantalla se quedaría muda sin que nadie se enterara.
 */
let enganchadoA = null;
/** [{id, quitado}] lo más nuevo primero, para el diagnóstico. */
let recordados = [];
let oyentes = [];

function ns() {
    return (globalThis.pedk && pedk.device && pedk.device.status) || null;
}

export function disponible() {
    const s = ns();
    return !!(s && typeof s.addOnPushStatusListener === 'function');
}

/** ¿Estamos enganchados al equipo que hay AHORA? */
export function escuchando() {
    return enganchadoA !== null && enganchadoA === ns();
}

/**
 * Traduce un identificador del equipo.
 * @returns {{texto: string, nivel: string, color: any}|null} null si no interesa
 */
export function mensajeDe(id) {
    const s = String(id || '');
    let m = MENSAJES[s];
    if (!m) {
        for (const [regex, msg] of FAMILIAS) {
            if (regex.test(s)) {
                m = msg;
                break;
            }
        }
    }
    return m ? { texto: m[0], nivel: m[1], color: COLORES[m[1]] } : null;
}

/** El identificador puede venir como campo o como método, según el firmware. */
function idDe(data) {
    if (!data) {
        return '';
    }
    try {
        if (typeof data.getStatusId === 'function') {
            return String(data.getStatusId());
        }
        if (data.id !== undefined) {
            return String(data.id);
        }
        return String(data);
    } catch (e) {
        return '';
    }
}

function avisar(id, quitado) {
    recordados.unshift({ id, quitado });
    if (recordados.length > MAX_RECORDADOS) {
        recordados = recordados.slice(0, MAX_RECORDADOS);
    }
    console.log('[estado] ' + (quitado ? '-' : '+') + id);
    // Los estados que se RETIRAN no se le cuentan a nadie: "ya no hay atasco" no es
    // algo que enseñar, y "ya no está enviando" confundiría más que ayudar.
    if (quitado) {
        return;
    }
    const m = mensajeDe(id);
    if (!m) {
        return;
    }
    for (const fn of oyentes.slice()) {
        try {
            fn(m, id);
        } catch (e) {
            console.log('[estado] oyente falló: ' + String((e && e.message) || e).slice(0, 40));
        }
    }
}

/** Se engancha UNA vez, al arrancar la app. */
export function iniciar() {
    const s = ns();
    if (escuchando()) {
        return true;
    }
    enganchadoA = null;
    if (!s || typeof s.addOnPushStatusListener !== 'function') {
        console.log('[estado] canal de estados: NO existe');
        return false;
    }
    try {
        if (s.addOnPushStatusListener((d) => avisar(idDe(d), false)) !== false) {
            enganchadoA = s;
        }
        if (typeof s.addOnRemoveStatusListener === 'function') {
            s.addOnRemoveStatusListener((d) => avisar(idDe(d), true));
        }
    } catch (e) {
        console.log('[estado] addOnPushStatusListener lanzó: ' + String((e && e.message) || e).slice(0, 40));
        enganchadoA = null;
    }
    console.log('[estado] canal de estados: ' + (escuchando() ? 'escuchando' : 'no se pudo'));
    return escuchando();
}

/** Las pantallas de copia y escaneo se apuntan mientras están abiertas. */
export function alCambiar(fn) {
    if (oyentes.indexOf(fn) < 0) {
        oyentes.push(fn);
    }
}

export function olvidar(fn) {
    oyentes = oyentes.filter((x) => x !== fn);
}

/** Para el diagnóstico: qué está levantado ahora y qué se ha visto pasar. */
export function informe() {
    const s = ns();
    const out = ['Estados: ' + (escuchando() ? 'escuchando' : disponible() ? 'sin enganchar' : 'NO existe')];
    if (s && typeof s.getStatusIdList === 'function') {
        for (const tipo of ['STATUS_ID_TYPE_ERROR', 'STATUS_ID_TYPE_WARNING']) {
            try {
                const lista = s.getStatusIdList((s.STATUS_TYPE && s.STATUS_TYPE[tipo]) || tipo);
                /*
                 * OJO: este firmware devuelve el TEXTO 'EINVALIDPARAM' en vez de una
                 * lista (visto en el panel el 25-09-2026, que enseñaba
                 * "WARNING: E,I,N,V,A,L,I,D,P,A,R,A,M" porque se recorría letra a
                 * letra). Sólo se acepta un array de verdad.
                 */
                if (!Array.isArray(lista)) {
                    if (lista !== undefined && lista !== null && String(lista) !== '') {
                        out.push(tipo.replace('STATUS_ID_TYPE_', '') + ': ' + String(lista).slice(0, 30));
                    }
                    continue;
                }
                if (lista.length) {
                    out.push(tipo.replace('STATUS_ID_TYPE_', '') + ': '
                        + lista.map((x) => String(x).replace('PEDK_SID_', '')).join(',').slice(0, 44));
                }
            } catch (e) { /* no todos los firmwares traen la lista */ }
        }
    }
    if (recordados.length) {
        out.push('Últimos: ' + recordados.slice(0, 3)
            .map((r) => (r.quitado ? '-' : '') + r.id.replace('PEDK_SID_', '')).join(' ').slice(0, 50));
    }
    return out;
}
