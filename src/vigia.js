/**
 * Vigía de trabajos (`pedk.jobctl`): qué trabajos llegan al equipo y si se pueden
 * cancelar. Es una herramienta de medición, no de producción.
 *
 * Por qué existe: medido el 15-09-2026 en la BM5220ADW, la impresión segura del
 * driver funciona sola (el documento espera en IM SGR del menú del equipo), pero
 * apagar FUNC_T_NET_PRINT rechaza TAMBIÉN los trabajos seguros. Para obligar a usar
 * la impresión segura queda una vía: dejar la red abierta y cancelar al vuelo lo
 * que llegue sin contraseña. Antes hay que saber, en el equipo real:
 *
 *  - qué tipo (`getJobType`) trae un trabajo normal del PC y uno seguro; el SDK sólo
 *    documenta PRINT_ENCRYPT, PRINT_URL, PRINT_USBMEMORY y PRINT_LOCAL;
 *  - si `cancelJob` para un trabajo antes de que salga papel.
 *
 * Nada de sondear `getJobList` en bucle: en el agente de CloudPrint degradó el táctil.
 * Se escucha con `addJobListener` y la lista sólo se lee al pulsar un botón.
 */
import { guard } from './guard.js';
import { COLOR, ambito, boton, etiqueta, pantalla, recortar } from './ui.js';
import { mostrar, repintar, pantallaActiva } from './router.js';

const MAX_EVENTOS = 30;
const LINEAS = 7;
const ARMADO_MS = 3 * 60 * 1000;

let escuchando = false;
let clavesAnotadas = false;
/** Decisor del guardián: fn(evento) -> 'cancelar' | 'permitir' | 'ignorar'. Lo pone app.js. */
let guardianFn = null;
const canceladosGuardian = new Set();
/** [{hora, origen, id, wo, tipo, estado, usuario, doc}] — lo más nuevo primero */
let eventos = [];
/** id -> 'tipo|estado' ya anotado, para no repetir el mismo evento. */
const ultimos = new Map();
/** {hasta, antes: Set de ids ya vistos} mientras la cancelación de prueba está armada. */
let armado = null;
let resultadoCancelacion = null;

let alVolver = null;
let mensaje = '';
let colorMensaje = COLOR.suave;

function jobctl() {
    return (globalThis.pedk && pedk.jobctl) || null;
}

function hora() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Lee un dato de un JobInfo por su método o, si llega un objeto crudo, por su campo. */
function leer(info, metodo, campo) {
    try {
        if (info && typeof info[metodo] === 'function') {
            const v = info[metodo]();
            return v === undefined || v === null ? '' : String(v);
        }
        const v = info ? info[campo] : undefined;
        return v === undefined || v === null ? '' : String(v);
    } catch (e) {
        return '¡' + String((e && e.message) || e).slice(0, 20);
    }
}

export function disponible() {
    const j = jobctl();
    return {
        escucha: !!(j && typeof j.addJobListener === 'function'),
        lista: !!(j && typeof j.getJobList === 'function'),
        cancela: !!(j && (typeof j.cancelJob === 'function' || typeof j.cancelJobByWoNum === 'function')),
    };
}

/** Registra el listener. Se llama una vez al arrancar la app. */
export function iniciar() {
    const j = jobctl();
    if (escuchando || !j || typeof j.addJobListener !== 'function') {
        return escuchando;
    }
    try {
        const Clase = j.JobListener;
        const oyente = typeof Clase === 'function' ? new Clase() : {};
        oyente.notify = guard('vigiaNotify', (info) => anotar('aviso', info));
        escuchando = j.addJobListener(oyente) !== false;
    } catch (e) {
        console.log('[vigia] addJobListener lanzó: ' + (e && e.message));
        escuchando = false;
    }
    console.log('[vigia] escuchando trabajos: ' + (escuchando ? 'sí' : 'no'));
    const tipos = globalThis.PRINTER_JOB_TYPE;
    console.log('[vigia] PRINTER_JOB_TYPE: ' + (tipos ? Object.keys(tipos).join(',') : 'no existe'));
    return escuchando;
}

/** Anota un trabajo (de un aviso o de la lista) y, si toca, prueba a cancelarlo. */
export function anotar(origen, info) {
    if (!clavesAnotadas && info && typeof info === 'object') {
        clavesAnotadas = true;
        const claves = Object.keys(info).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(info) || {}));
        console.log('[vigia] forma del trabajo: ' + claves.join(','));
    }
    const e = {
        hora: hora(),
        origen,
        id: leer(info, 'getJobId', 'id'),
        wo: leer(info, 'getWoNum', 'woNum'),
        tipo: leer(info, 'getJobType', 'jobType'),
        estado: leer(info, 'getJobState', 'state'),
        usuario: leer(info, 'getUserName', 'username'),
        doc: leer(info, 'getDocumentName', 'documentName'),
        paginas: leer(info, 'getPrintPageNum', 'currentPages') + '/' + leer(info, 'getPrintPageTotalNum', 'totalPages'),
    };
    const clave = e.tipo + '|' + e.estado;
    const nuevo = !ultimos.has(e.id);
    if (ultimos.get(e.id) !== clave) {
        ultimos.set(e.id, clave);
        eventos.unshift(e);
        if (eventos.length > MAX_EVENTOS) {
            eventos = eventos.slice(0, MAX_EVENTOS);
        }
        console.log('[vigia] ' + origen + ' #' + e.id + ' wo=' + e.wo + ' tipo=' + e.tipo + ' estado=' + e.estado
            + ' usuario=' + e.usuario + ' doc=' + e.doc + ' pag=' + e.paginas);
    }
    aplicarGuardian(e);
    if (armado && nuevo && candidatoACancelar(e)) {
        cancelarPrueba(e);
    }
    // Medido el 15-09-2026: el aviso trae tipo "PRINT" tanto en normal como en seguro.
    // La lista quizá dé el tipo fino (PRINT_NORMAL / PRINT_ENCRYPT): se lee UNA vez por
    // trabajo nuevo, nunca en bucle. Sólo desde avisos, para no encadenar lecturas.
    if (nuevo && origen === 'aviso') {
        leerLista();
    }
    if (pantallaActiva() === 'vigia') {
        repintar();
    }
    return e;
}

/**
 * El guardián: sólo se imprime con usuario y contraseña. Cada trabajo que llega se
 * consulta con app.js; si dice 'cancelar', se para antes de que salga papel (medido:
 * cancelJob en estado Running no saca hoja). Se cancela una sola vez por trabajo.
 */
export function guardian(fn) {
    guardianFn = fn;
}

function claveTrabajo(e) {
    return e.id + '|' + e.wo;
}

function aplicarGuardian(e) {
    if (typeof guardianFn !== 'function') {
        return;
    }
    const clave = claveTrabajo(e);
    if (canceladosGuardian.has(clave)) {
        return;
    }
    let decision = 'ignorar';
    try {
        decision = guardianFn(e);
    } catch (err) {
        console.log('[guardian] error al decidir: ' + (err && err.message));
    }
    if (decision === 'cancelar') {
        canceladosGuardian.add(clave);
        const r = cancelarTrabajo(e);
        console.log('[guardian] CANCELADO #' + e.id + ' wo=' + e.wo + ' doc=' + e.doc + ' -> ' + r);
    }
}

/** Cancela un trabajo por id y, si no, por número de orden. */
function cancelarTrabajo(e) {
    const j = jobctl();
    const intentos = [];
    let ok = false;
    const probar = (nombre, arg) => {
        if (ok || !j || typeof j[nombre] !== 'function' || arg === '' || arg === undefined) {
            return;
        }
        try {
            const r = j[nombre](isNaN(Number(arg)) ? arg : Number(arg));
            intentos.push(nombre + '=' + r);
            ok = r === true || /SUCCESS|^0$/i.test(String(r));
        } catch (err) {
            intentos.push(nombre + ' lanzó');
        }
    };
    probar('cancelJob', e.id);
    probar('cancelJobByWoNum', e.wo);
    return intentos.join(' · ') || 'sin función';
}

function candidatoACancelar(e) {
    if (Date.now() > armado.hasta) {
        armado = null;
        resultadoCancelacion = 'caducó sin llegar ningún trabajo';
        return false;
    }
    return !armado.antes.has(e.id) && !/SCAN|COPY|FAX/i.test(e.tipo);
}

function cancelarPrueba(e) {
    armado = null;
    const j = jobctl();
    const intentos = [];
    let ok = false;
    const probar = (nombre, arg) => {
        if (ok || !j || typeof j[nombre] !== 'function' || arg === '') {
            return;
        }
        try {
            const r = j[nombre](isNaN(Number(arg)) ? arg : Number(arg));
            intentos.push(nombre + '=' + r);
            ok = r === true || /SUCCESS|^0$/i.test(String(r));
        } catch (err) {
            intentos.push(nombre + ' lanzó ' + String((err && err.message) || err).slice(0, 30));
        }
    };
    probar('cancelJob', e.id);
    probar('cancelJobByWoNum', e.wo);
    resultadoCancelacion = '#' + e.id + ' ' + e.tipo + ': ' + (intentos.join(' · ') || 'sin función para cancelar');
    console.log('[vigia] cancelación de prueba ' + resultadoCancelacion);
}

/** Lee la lista de trabajos del equipo una vez. */
export function leerLista() {
    const j = jobctl();
    if (!j || typeof j.getJobList !== 'function') {
        return -1;
    }
    let lista = [];
    try {
        lista = j.getJobList() || [];
    } catch (e) {
        console.log('[vigia] getJobList lanzó: ' + (e && e.message));
        return -1;
    }
    console.log('[vigia] getJobList: ' + lista.length + ' trabajo(s)');
    lista.forEach((info) => anotar('lista', info));
    return lista.length;
}

/** La próxima impresión que aparezca se intenta cancelar. */
export function armarCancelacion(ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    armado = { hasta: t + ARMADO_MS, antes: new Set(ultimos.keys()) };
    resultadoCancelacion = null;
}

export function estadoCancelacion(ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    if (armado && t > armado.hasta) {
        armado = null;
        resultadoCancelacion = 'caducó sin llegar ningún trabajo';
    }
    return armado ? 'armada' : resultadoCancelacion;
}

export function ultimosEventos() {
    return eventos.slice();
}

/** Líneas cortas para el informe de Diagnóstico. */
export function informe() {
    const d = disponible();
    const out = ['Trabajos: escucha ' + (escuchando ? 'sí' : d.escucha ? 'falló' : 'no')
        + ' · lista ' + (d.lista ? 'sí' : 'no') + ' · cancelar ' + (d.cancela ? 'sí' : 'no')];
    const u = eventos[0];
    if (u) {
        out.push('Ult. trabajo: ' + u.tipo + ' ' + u.estado + ' ' + u.usuario);
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Pantalla                                                             */
/* ------------------------------------------------------------------ */

export function abrirVigia(volver) {
    alVolver = volver;
    mensaje = escuchando ? 'Mande algo a imprimir: aparecerá aquí' : 'Este equipo no avisa: use Leer lista';
    colorMensaje = COLOR.suave;
    mostrar('vigia', render);
}

function decir(texto, color) {
    mensaje = texto || '';
    colorMensaje = color || COLOR.suave;
}

function render() {
    ambito('vg');
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 340, 22, 'Trabajos que llegan', COLOR.texto));
    w.push(boton('volver', 376, 6, 92, 30, 'Volver', COLOR.acento, () => alVolver && alVolver()));
    if (eventos.length === 0) {
        w.push(etiqueta('vacio', 12, 60, 456, 22, 'Todavía no llegó ningún trabajo', COLOR.tenue, 'center'));
    }
    eventos.slice(0, LINEAS).forEach((e, i) => {
        const texto = e.hora + ' #' + e.id + (e.origen === 'lista' ? ' L ' : ' ') + e.tipo + ' '
            + e.estado.replace('JBSts_', '') + ' ' + e.paginas + 'p ' + e.usuario;
        w.push(etiqueta('e' + i, 12, 40 + i * 25, 456, 22, recortar(texto, 62), COLOR.texto));
    });
    w.push(boton('lista', 12, 222, 220, 34, 'Leer lista', COLOR.acento, () => {
        const n = leerLista();
        decir(n < 0 ? 'Este equipo no da la lista' : n + ' trabajo(s) en la lista', n < 0 ? COLOR.peligro : COLOR.ok);
        repintar();
    }));
    const est = estadoCancelacion();
    w.push(boton('cancelar', 244, 222, 224, 34, est === 'armada' ? 'Cancelación armada' : 'Cancelar el próximo',
        est === 'armada' ? COLOR.aviso : COLOR.peligro, () => {
            armarCancelacion();
            decir('Mande UNA impresión normal ahora', COLOR.aviso);
            repintar();
        }));
    w.push(etiqueta('msg', 12, 262, 456, 22, recortar(mensaje, 62), colorMensaje));
    w.push(etiqueta('canc', 12, 288, 456, 22, recortar(est && est !== 'armada' ? 'Cancelación: ' + est : '', 62),
        COLOR.suave));
    return w;
}

/** Solo para las pruebas. */
export function _reiniciar() {
    escuchando = false;
    clavesAnotadas = false;
    eventos = [];
    ultimos.clear();
    armado = null;
    resultadoCancelacion = null;
    guardianFn = null;
    canceladosGuardian.clear();
}
