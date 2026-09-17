/**
 * El historial de trabajos del equipo (`pedk.jobctl`): de aquí sale lo que se cuenta.
 *
 * Se cuenta desde el historial y no desde la app porque es lo único que ve TODO lo
 * que sale del equipo, venga de un PC, de un cable o de la copia del panel. Medido en
 * la BM5220ADW con el agente de CloudPrint:
 *
 *   {"job_id":"3","start_time":"2026-08-13 05:15:18","type":"JOB_HISTORY_TYPE_PRINT",
 *    "status":"JOB_HISTORY_STATUS_COMPLETED","user_name":"Admin","host_name":"",
 *    "filename":"","param":{"copies":"0","pages":"1","duplex":"SINGLE",...}}
 *
 *  - `param.pages` son PAPELES que salieron: ya lleva multiplicadas las copias.
 *    Es justo lo que se quiere contar.
 *  - `job_id` del historial es propio (112, 113…) y no casa con `getJobId()` de un
 *    trabajo; aquí no hace falta casarlo con nada.
 *
 * Una entrada se cuenta la primera vez que se ve, por `job_id` + `start_time`. La
 * primera lectura tras instalar sólo marca lo que ya había: lo impreso antes de que
 * existiera la app no se le carga a nadie.
 */
import * as store from './store.js';

function jobctl() {
    return (globalThis.pedk && pedk.jobctl) || null;
}

/**
 * Enciende el registro de trabajos del firmware. Medido del 13-09 al 16-09-2026: la
 * lista se quedó en 135 trabajos y el último (#135) no cambió aunque se imprimió varias
 * veces, así que el equipo no estaba anotando. VT1.24 trae el interruptor.
 */
export function activar() {
    const j = jobctl();
    if (!j || typeof j.enableJobHistory !== 'function') {
        return null;
    }
    try {
        const r = j.enableJobHistory();
        console.log('[historial] enableJobHistory -> ' + r);
        return r;
    } catch (e) {
        console.log('[historial] enableJobHistory lanzó: ' + (e && e.message));
        return null;
    }
}

export function disponible() {
    const j = jobctl();
    return !!(j && (typeof j.getJobHistoryList === 'function' || typeof j.getJobLastHistory === 'function'));
}

/** 'PRINT' | 'COPY' | 'SCAN' | 'OTRO' */
function tipoDe(t) {
    const s = String(t || '').toUpperCase();
    if (s.indexOf('COPY') >= 0) {
        return 'COPY';
    }
    if (s.indexOf('SCAN') >= 0) {
        return 'SCAN';
    }
    if (s.indexOf('PRINT') >= 0) {
        return 'PRINT';
    }
    return 'OTRO';
}

function paginasDe(e) {
    const p = e && e.param;
    if (!p) {
        return 0;
    }
    const bruto = p.pages !== undefined ? p.pages : p.CopyScanPages;
    const n = parseInt(String(bruto), 10);
    // Techo de cordura: este firmware ya devolvió enteros basura con pinta de válidos.
    return Number.isNaN(n) || n < 0 || n > 10000 ? 0 : n;
}

/** Normaliza una entrada cruda del equipo. */
export function normalizar(e) {
    if (!e || e.job_id === undefined || e.job_id === null) {
        return null;
    }
    const id = String(e.job_id);
    const hora = e.start_time ? String(e.start_time) : '';
    const doc = e.filename && e.filename !== '-' ? String(e.filename) : null;
    const origen = [e.user_name, e.host_name].filter((x) => x && x !== 'Admin').join('@') || null;
    return {
        clave: id + '|' + hora,
        id,
        tipo: tipoDe(e.type),
        estado: e.status ? String(e.status).replace('JOB_HISTORY_STATUS_', '') : null,
        paginas: paginasDe(e),
        hora: hora || null,
        doc,
        origen,
    };
}

/** Entradas del historial, de la más vieja a la más nueva. */
export function leerEntradas() {
    const j = jobctl();
    if (!j) {
        return [];
    }
    let crudas = null;
    try {
        if (typeof j.getJobHistoryList === 'function') {
            crudas = j.getJobHistoryList();
        }
    } catch (e) {
        console.log('[historial] getJobHistoryList lanzó: ' + (e && e.message));
    }
    if (!Array.isArray(crudas)) {
        try {
            const ultima = typeof j.getJobLastHistory === 'function' ? j.getJobLastHistory() : null;
            crudas = ultima ? [ultima] : [];
        } catch (e) {
            crudas = [];
        }
    }
    const lista = crudas.map(normalizar).filter((x) => x !== null);
    // No se sabe en qué orden las da el equipo: por id numérico si lo es.
    if (lista.every((x) => /^\d+$/.test(x.id))) {
        lista.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    }
    return lista;
}

/**
 * Revisa el historial y entrega los trabajos nuevos de impresión y copia.
 * @param {function(entrada)} alNuevo
 * @returns {number} cuántos trabajos nuevos se entregaron
 */
export function revisar(alNuevo) {
    const entradas = leerEntradas();
    if (!store.historialIniciado()) {
        store.marcarVistos(entradas.map((e) => e.clave), true);
        console.log('[historial] primera lectura: ' + entradas.length + ' trabajo(s) previos, no se cuentan');
        return 0;
    }
    const nuevas = entradas.filter((e) => !store.yaVisto(e.clave));
    if (nuevas.length === 0) {
        return 0;
    }
    // Se marcan ANTES de contar: un fallo a mitad no debe hacer que se cuenten dos veces.
    store.marcarVistos(nuevas.map((e) => e.clave), false);
    let entregados = 0;
    for (const e of nuevas) {
        if (e.tipo !== 'PRINT' && e.tipo !== 'COPY') {
            continue;
        }
        try {
            alNuevo(e);
            entregados++;
        } catch (err) {
            console.log('[historial] error al contar ' + e.clave + ': ' + (err && err.message));
        }
    }
    return entregados;
}

let temporizador = null;

/**
 * Vigila el historial. Da una vuelta cada `pasoMs` y sólo LEE cuando pasó
 * `intervalo()` desde la última lectura: así, al abrir una sesión, el ritmo rápido
 * empieza en la vuelta siguiente y no cuando venza la espera larga.
 */
export function vigilar(alNuevo, intervalo, pasoMs) {
    detener();
    let ultima = 0;
    const vuelta = () => {
        const ahora = Date.now();
        if (ahora - ultima >= intervalo()) {
            ultima = ahora;
            try {
                revisar(alNuevo);
            } catch (e) {
                console.log('[historial] vuelta fallida: ' + (e && e.message));
            }
        }
        temporizador = setTimeout(vuelta, pasoMs);
    };
    vuelta();
}

export function detener() {
    if (temporizador !== null) {
        clearTimeout(temporizador);
        temporizador = null;
    }
}
