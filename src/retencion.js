/**
 * Modo RETENCIÓN: impresión segura del driver, listada y liberada desde la app.
 *
 * El PC manda el documento como "Impresión segura" con nombre y contraseña; el equipo
 * lo guarda (se ve en IM SGR del menú del equipo, medido el 15-09-2026). Cada persona
 * pone en el driver su usuario de la app como Nombre y su PIN como Contraseña; en la
 * impresora entra con usuario y PIN (validados por la app) y aquí se buscan sus
 * documentos y se imprimen: una sola identificación, y el historial queda a su nombre.
 *
 * Por qué no basta con `new EncryptJobPrint()` (fuente del firmware leída con
 * Diagnóstico > Explorar SDK, 16-09-2026):
 *
 *   class EncryptJobPrint extends PesfPrintJob {
 *     constructor(jobId) { super(); super.EncryptJobPrint(jobId); ... }
 *     setJobId() { throw TypeError('not a function') }   // "para evitar llamadas externas"
 *
 * El constructor lanza justo "not a function", el mensaje de esa trampa: todo indica
 * que la parte nativa llama a `setJobId` y cae en la sobrescritura. Las funciones que
 * importan son nativas de `PesfPrintJob` (getUserNameList, getEncryptJobList,
 * EncryPrint_start) y devuelven TEXTO separado por comas, no objetos JobInfo como dice
 * la documentación. Se prueban, en orden, formas de construir sin la trampa y se
 * recuerda la primera que funciona; cada intento queda en el log con [retencion].
 */

/** Tras liberar, el guardián deja pasar impresiones durante este tiempo (el trabajo liberado). */
const VENTANA_MS = 25000;

let creado = null;   // {obj, variante}
let errores = [];
/** Última consulta: EncryPrint_start necesita dueño, posición y nombre del documento. */
let consulta = null; // {pin, docs: [{dueno, indice, item}]} — el PIN sólo vive mientras dura la sesión

function printNs() {
    return (globalThis.pedk && pedk.jobs && pedk.jobs.print) || null;
}

function claseOficial() {
    const ns = printNs();
    return ns && typeof ns.EncryptJobPrint === 'function' ? ns.EncryptJobPrint : null;
}

function claseBase() {
    if (typeof globalThis.PesfPrintJob === 'function') {
        return globalThis.PesfPrintJob;
    }
    const oficial = claseOficial();
    const base = oficial ? Object.getPrototypeOf(oficial) : null;
    return typeof base === 'function' && base !== Function.prototype ? base : null;
}

function mensaje(e) {
    return String((e && e.message) || e).slice(0, 60);
}

/** Formas de obtener un objeto con las funciones nativas de impresión segura. */
const VARIANTES = [
    ['oficial', () => {
        const Clase = claseOficial();
        return Clase ? new Clase() : null;
    }],
    ['oficial sin trampa', () => {
        const Clase = claseOficial();
        const base = claseBase();
        if (!Clase || !base || typeof base.prototype.setJobId !== 'function') {
            return null;
        }
        const trampa = Clase.prototype.setJobId;
        Clase.prototype.setJobId = base.prototype.setJobId;
        try {
            return new Clase();
        } finally {
            Clase.prototype.setJobId = trampa;
        }
    }],
    ['propia', () => {
        const Base = claseBase();
        if (!Base) {
            return null;
        }
        class Retenidos extends Base {
            constructor() {
                super();
                super.EncryptJobPrint();
            }
        }
        return new Retenidos();
    }],
    ['base', () => {
        const Base = claseBase();
        if (!Base) {
            return null;
        }
        const obj = new Base();
        try {
            obj.EncryptJobPrint();
        } catch (e) {
            console.log('[retencion] base.EncryptJobPrint() lanzó: ' + mensaje(e) + ' (se sigue igual)');
        }
        return obj;
    }],
];

function crear() {
    if (creado) {
        return creado;
    }
    errores = [];
    for (const [variante, fabricar] of VARIANTES) {
        try {
            const obj = fabricar();
            if (!obj) {
                errores.push(variante + ': no existe');
                continue;
            }
            if (typeof obj.getEncryptJobList !== 'function') {
                errores.push(variante + ': sin getEncryptJobList');
                continue;
            }
            creado = { obj, variante };
            console.log('[retencion] impresión segura disponible con la variante "' + variante + '"'
                + (errores.length ? ' (antes: ' + errores.join(' | ') + ')' : ''));
            return creado;
        } catch (e) {
            errores.push(variante + ': ' + mensaje(e));
            console.log('[retencion] variante "' + variante + '" lanzó: ' + mensaje(e));
        }
    }
    return null;
}

/** @returns {{ok: boolean, detalle: string}} */
export function disponible() {
    const c = crear();
    return c
        ? { ok: true, detalle: 'variante ' + c.variante }
        : { ok: false, detalle: errores.join(' | ') || 'el firmware no expone EncryptJobPrint' };
}

/** Enciende la función en el equipo; sin ella no retiene nada. */
export function encenderFuncion() {
    const s = globalThis.pedk && pedk.device && pedk.device.setting;
    if (!s || typeof s.setFunctionSwitch !== 'function') {
        return false;
    }
    try {
        const tipos = s.FUNCTION_TYPE || {};
        const sw = s.FUNCTION_SWITCH || {};
        s.setFunctionSwitch(tipos.FUNC_T_SECURE_PRINT || 'FUNC_T_SECURE_PRINT', sw.FUNC_SW_ON || 'FUNC_SW_ON');
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Convierte lo que da el firmware en una lista. Llega como texto con comas, a veces
 * con corchetes y comillas (`["a","b"]`), que el propio firmware quita a mano.
 */
export function parsearLista(valor) {
    if (valor === null || valor === undefined) {
        return [];
    }
    if (Array.isArray(valor)) {
        return valor.map((x) => String(x).trim()).filter((x) => x.length > 0);
    }
    const s = String(valor).trim();
    if (s.length === 0) {
        return [];
    }
    return s.split(',')
        .map((x) => x.trim().replace(/^[\["\s]+|[\]"\s]+$/g, ''))
        .filter((x) => x.length > 0);
}

function llamar(nombre, ...args) {
    const c = crear();
    if (!c) {
        return null;
    }
    try {
        const v = c.obj[nombre](...args);
        console.log('[retencion] ' + nombre + ' -> ' + JSON.stringify(v));
        return v;
    } catch (e) {
        console.log('[retencion] ' + nombre + ' lanzó: ' + mensaje(e));
        return null;
    }
}

/** Nombres con documentos retenidos, tal como los guardó el equipo. */
export function nombresConTrabajos() {
    return parsearLista(llamar('getUserNameList'));
}

/**
 * ¿Ese nombre de trabajo es de este usuario? Medido el 16-09-2026: la lista trae el
 * "Nombre" que la persona puso en el driver, y el equipo numera los repetidos
 * ("t", "t_1", "t_2"…). El dueño que guarda el equipo es el usuario de Windows, que
 * puede ser compartido: por eso manda el nombre del trabajo, no el dueño.
 */
export function esDe(item, usuario) {
    const i = String(item).toLowerCase();
    const u = String(usuario).toLowerCase();
    return i === u || (i.indexOf(u + '_') === 0 && /^\d+$/.test(i.substring(u.length + 1)));
}

/**
 * Documentos retenidos de un usuario ya validado en la app. Se piden, con su PIN como
 * contraseña, a cada dueño que tiene algo retenido, y se quedan los que llevan su nombre.
 * @returns {Array<{id: number, doc: string, dueno: string, paginas: number}>}
 */
export function trabajosDe(usuario, pin) {
    consulta = null;
    const docs = [];
    for (const dueno of nombresConTrabajos()) {
        parsearLista(llamar('getEncryptJobList', dueno, String(pin))).forEach((item, indice) => {
            if (esDe(item, usuario)) {
                docs.push({ dueno, indice, item });
            }
        });
    }
    consulta = { pin: String(pin), docs };
    return docs.map((d, id) => ({ id, doc: d.item, dueno: d.dueno, paginas: 0 }));
}

/**
 * La función nativa no devuelve un resultado fiable: medido el 16-09-2026 devolvió
 * -2.2093146182312478e-95 y el documento salió. Sólo cuenta como fallo un error
 * explícito; si de verdad imprimió se comprueba después con `sigueRetenido`.
 */
function fallo(r) {
    return (typeof r === 'number' && Number.isInteger(r) && r < 0)
        || (typeof r === 'string' && /FAIL|ERR|PARAM|DEFICIENCY|OTHER/i.test(r));
}

let ultimaLiberacion = null; // {dueno, item, pin}
let ventanaHasta = 0;        // hasta cuándo el guardián debe dejar pasar el trabajo liberado

/** ¿Se acaba de liberar un documento y el guardián debe dejarlo imprimir? */
export function ventanaAbierta(ahora) {
    return (typeof ahora === 'number' ? ahora : Date.now()) < ventanaHasta;
}

/**
 * Imprime un documento retenido de la última consulta. Tras imprimir, el equipo lo
 * saca de la lista y la posición de los demás cambia: hay que volver a consultar
 * antes de liberar otro.
 */
export function liberar(id) {
    const c = crear();
    if (!c) {
        return { ok: false, detalle: 'sin impresión segura' };
    }
    const d = consulta && consulta.docs[id];
    if (!d) {
        return { ok: false, detalle: 'consulte la lista otra vez' };
    }
    const ns = printNs();
    const param = ns && typeof ns.PrintParameterSet === 'function' ? new ns.PrintParameterSet() : {};
    const cuota = {};
    const pin = consulta.pin;
    consulta = null;
    try {
        let r;
        if (c.variante.indexOf('oficial') === 0 && typeof c.obj.start === 'function') {
            // La start() oficial lee la lista que dejó getEncryptJobList en el módulo.
            c.obj.getEncryptJobList(d.dueno, pin);
            r = c.obj.start(d.indice, param, cuota);
        } else {
            r = c.obj.EncryPrint_start(d.indice, param, cuota, d.dueno, d.item);
        }
        console.log('[retencion] liberar "' + d.item + '" de ' + d.dueno + ' #' + d.indice + ' (' + c.variante + ') -> ' + JSON.stringify(r));
        if (fallo(r)) {
            return { ok: false, detalle: String(r) };
        }
        ultimaLiberacion = { dueno: d.dueno, item: d.item, pin };
        ventanaHasta = Date.now() + VENTANA_MS;
        return { ok: true, detalle: String(r) };
    } catch (e) {
        console.log('[retencion] liberar lanzó: ' + mensaje(e));
        return { ok: false, detalle: mensaje(e) };
    }
}

/** ¿El último documento liberado sigue en la lista? (true = no se imprimió) */
export function sigueRetenido() {
    const u = ultimaLiberacion;
    if (!u) {
        return false;
    }
    return parsearLista(llamar('getEncryptJobList', u.dueno, u.pin)).indexOf(u.item) >= 0;
}

/** Solo para las pruebas. */
export function _reiniciar() {
    creado = null;
    errores = [];
    consulta = null;
    ultimaLiberacion = null;
    ventanaHasta = 0;
}
