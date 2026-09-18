/**
 * Memoria del equipo: usuarios, contadores, registro y ajustes. No hay servidor: esto
 * es la fuente de verdad, y por eso se guarda en DOS SITIOS a la vez.
 *
 * POR QUÉ SE PERDÍAN LOS USUARIOS AL REINICIAR (medido el 17-09-2026 con
 * Diagnóstico > Probar memoria, log [explorar]):
 *
 *   `getUserDefinedData()` NO devuelve un objeto como dice la doc del SDK: en esta
 *   impresora devuelve un STRING (`""` con la memoria vacía). El código comprobaba
 *   `typeof todo === 'object'` y por tanto **nunca conseguía releer sus propios
 *   datos**: cada arranque empezaba con cero usuarios. No era una carrera al
 *   encender; fallaba siempre. Aquí se parsea el string.
 *
 * Y se guarda además con `Object.save`/`Object.load`, que es lo que la doc recomienda
 * y lo único cuya ida y vuelta está COMPROBADA en este equipo. Ojo: `Object.save`
 * devuelve basura (se midió -4.4e-95, igual que `EncryPrint_start`), así que su
 * retorno no se mira; la escritura se verifica releyéndola.
 *
 * Lo que este equipo NO tiene, por si alguien lo busca: no hay acceso a ficheros de
 * una flash USB (sólo `setUsbHostEnable`, encender/apagar) y `getFileList` no existe.
 * Para sacar o meter datos, lo que sí hay es red: `pedk.net.wget.wget` y
 * `pedk.net.http.uploadFile`.
 *
 * De los PIN sólo se guarda una huella. No es criptografía seria —este motor no trae
 * `crypto`, y un PIN de 4 dígitos se adivina probando—; lo que protege de verdad es
 * el límite de intentos.
 */
import { config } from './config.js';

const CLAVE = 'impresionPin';

/**
 * Fichero de `Object.save`. Se guarda en los dos nombres porque el equipo aceptó los
 * dos y no se sabe cuál sobrevive a una reinstalación: `/storage` es, según la doc,
 * el almacenamiento persistente.
 */
const FICHEROS = ['impresionPin.json', '/storage/impresionPin.json'];

/** Contador donde cae lo que se imprimió sin ninguna sesión abierta. */
export const SIN_SESION = '(sin sesion)';

function ns() {
    return (globalThis.pedk && pedk.device && pedk.device.storage) || null;
}

function vacio() {
    return {
        version: 1,
        /** [{nombre, huella, activo, creado}] */
        usuarios: [],
        /** {nombre: {impresiones, paginas, copias, paginasCopia}} */
        contadores: {},
        /** [{hora, quien, tipo, paginas, doc, estado, origen}] — lo más nuevo primero */
        registro: [],
        /** Trabajos del historial ya contados (claves). */
        vistos: [],
        /** false hasta la primera lectura del historial: lo anterior no se cuenta. */
        historialIniciado: false,
        ajustes: {
            /** 'sesion' (desbloquea al entrar) o 'retencion' (impresión confidencial). */
            modo: 'sesion',
            /** Apagado de fábrica: nada se bloquea hasta que el admin lo encienda. */
            bloqueoActivo: false,
            /** Bloquear también la copia desde el panel fuera de sesión. */
            bloquearCopia: false,
            minutosSesion: config.MINUTOS_SESION_DEFECTO,
            huellaAdmin: null,
            /** IP del PC que recibe el respaldo; null = respaldo apagado. */
            respaldoIp: null,
        },
    };
}

let cache = null;

/**
 * MODO SÓLO LECTURA. El fallo que borraba a los usuarios estaba aquí: una lectura
 * FALLIDA y "todavía no hay nada guardado" acababan las dos en un objeto vacío, y el
 * primer `guardar()` escribía ese vacío ENCIMA de los datos buenos.
 *
 * Y la app escribe a los pocos milisegundos de arrancar: `arrancar()` llama a
 * `historial.vigilar`, que da su primera vuelta en el acto, ve `historialIniciado`
 * falso y llama a `marcarVistos(..., true)`. O sea que el momento más probable de que
 * el almacenamiento aún no responda —recién encendida la impresora— es justo el
 * momento en que la app graba.
 *
 * Ahora se distingue: si la lectura LANZA o no devuelve un objeto, no se guarda nada
 * y se reintenta leer más tarde. Perder los contadores de un rato es reparable;
 * perder los usuarios y el PIN de administrador, no.
 */
let soloLectura = false;
let motivo = null;
let ultimoIntento = 0;
/** Cada cuánto se vuelve a intentar leer mientras se está en sólo lectura. */
const REINTENTO_MS = 15000;

/** @returns {{soloLectura: boolean, motivo: ?string}} */
export function estado() {
    return { soloLectura, motivo };
}

/**
 * Lo que devuelva `getUserDefinedData`, convertido a objeto.
 *
 * En este equipo devuelve un STRING: `""` cuando no hay nada guardado, y el JSON
 * cuando sí. La doc del SDK promete un Object, así que se aceptan los dos. Un string
 * que no sea JSON es un ERROR_NO del SDK: eso LANZA, porque un fallo de lectura no
 * puede confundirse nunca con una memoria vacía (confundirlos era lo que la borraba).
 *
 * @returns {?object} el objeto completo de la memoria, o null si está vacía.
 * @throws si lo devuelto no se entiende.
 */
function comoObjeto(valor) {
    if (valor === null || valor === undefined) {
        return null;
    }
    if (typeof valor === 'object') {
        return valor;
    }
    if (typeof valor === 'string') {
        const s = valor.replace(/^\s+|\s+$/g, '');
        if (s === '') {
            return null;                // memoria vacía (medido en la BM5220ADW)
        }
        const d = JSON.parse(s);        // si es un ERROR_NO, lanza: es lo correcto
        if (!d || typeof d !== 'object') {
            throw new Error('el JSON no es un objeto');
        }
        return d;
    }
    throw new Error('devolvió ' + typeof valor);
}

/** ¿Tiene pinta de ser nuestro registro y no basura? */
function esNuestro(d) {
    return !!d && typeof d === 'object' && Array.isArray(d.usuarios);
}

/** Lee el fichero de `Object.save`. Devuelve null si no hay o no vale. */
function leerFichero() {
    const O = globalThis.Object;
    if (typeof O.load !== 'function') {
        return null;
    }
    for (const f of FICHEROS) {
        try {
            const d = O.load(f);
            if (esNuestro(d)) {
                return d;
            }
        } catch (e) { /* no existe todavía, o no se puede leer: se prueba el siguiente */ }
    }
    return null;
}

/**
 * Lee la memoria del equipo de los dos sitios. Manda el fichero; si está vacío pero
 * `getUserDefinedData` sí tiene datos, se adoptan (y el siguiente guardado los pasa
 * al fichero). Sólo lanza si NINGUNO se pudo leer: con un sitio bueno se sigue.
 *
 * @returns {?object} lo guardado, o null si el equipo está legítimamente vacío.
 */
function leerDelEquipo() {
    const delFichero = leerFichero();
    if (delFichero) {
        return delFichero;
    }
    const s = ns();
    if (!s || typeof s.getUserDefinedData !== 'function') {
        // Sin API no hay nada que proteger: no se puede leer ni escribir.
        return null;
    }
    const todo = comoObjeto(s.getUserDefinedData());
    return (todo && todo[CLAVE]) || null;
}

function cargar() {
    if (cache) {
        // Si se quedó en sólo lectura, se vuelve a intentar de vez en cuando: puede
        // que el almacenamiento sólo estuviera dormido al arrancar.
        if (soloLectura && Date.now() - ultimoIntento >= REINTENTO_MS) {
            ultimoIntento = Date.now();
            try {
                const guardado = leerDelEquipo();
                if (guardado) {
                    cache = normalizar(guardado);
                    soloLectura = false;
                    motivo = null;
                    console.log('[store] la memoria respondió: se recuperan los datos y se vuelve a guardar');
                }
            } catch (e) {
                console.log('[store] sigue sin poder leerse: ' + (e && e.message));
            }
        }
        return cache;
    }
    ultimoIntento = Date.now();
    let guardado = null;
    try {
        guardado = leerDelEquipo();
    } catch (e) {
        soloLectura = true;
        motivo = String((e && e.message) || e).slice(0, 60);
        console.log('[store] NO SE PUDO LEER (' + motivo + '): no se guardará nada para no borrar lo que haya');
    }
    cache = normalizar(guardado);
    return cache;
}

function normalizar(d) {
    const base = vacio();
    if (!d || typeof d !== 'object') {
        return base;
    }
    base.usuarios = Array.isArray(d.usuarios) ? d.usuarios.filter((u) => u && u.nombre) : [];
    base.contadores = d.contadores && typeof d.contadores === 'object' ? d.contadores : {};
    base.registro = Array.isArray(d.registro) ? d.registro : [];
    base.vistos = Array.isArray(d.vistos) ? d.vistos : [];
    base.historialIniciado = !!d.historialIniciado;
    if (d.ajustes && typeof d.ajustes === 'object') {
        const a = d.ajustes;
        base.ajustes.modo = a.modo === 'retencion' ? 'retencion' : 'sesion';
        base.ajustes.bloqueoActivo = !!a.bloqueoActivo;
        base.ajustes.bloquearCopia = !!a.bloquearCopia;
        if (config.MINUTOS_SESION_OPCIONES.indexOf(a.minutosSesion) >= 0) {
            base.ajustes.minutosSesion = a.minutosSesion;
        }
        base.ajustes.huellaAdmin = a.huellaAdmin || null;
        base.ajustes.respaldoIp = typeof a.respaldoIp === 'string' && a.respaldoIp ? a.respaldoIp : null;
    }
    return base;
}

/** Si ya se comprobó que una escritura llega de verdad al equipo. */
let escrituraComprobada = false;

/**
 * Guarda en los DOS sitios: el fichero de `Object.save` y `setUserDefinedData`.
 * Basta con que uno funcione. Que fallen los dos es lo que se avisa a gritos.
 */
function guardar() {
    if (soloLectura) {
        console.log('[store] NO se guarda: la memoria no se pudo leer (' + motivo + ')');
        return false;
    }
    const enFichero = guardarEnFichero();
    const enMemoria = guardarEnMemoria();
    if (!enFichero && !enMemoria) {
        console.log('[store] AVISO GRAVE: no se pudo guardar en ningún sitio');
        return false;
    }
    if (!escrituraComprobada) {
        escrituraComprobada = true;
        comprobarEscritura(enFichero, enMemoria);
    }
    revision++;
    return true;
}

/** `Object.save`: devuelve basura, así que sólo cuenta que no lance. */
function guardarEnFichero() {
    const O = globalThis.Object;
    if (typeof O.save !== 'function') {
        return false;
    }
    let alguno = false;
    for (const f of FICHEROS) {
        try {
            O.save(f, cache);
            alguno = true;
        } catch (e) {
            console.log('[store] Object.save ' + f + ': ' + (e && e.message));
        }
    }
    return alguno;
}

/**
 * Lo que se manda a `setUserDefinedData`: SÓLO lo pequeño y precioso.
 *
 * Medido el 18-09-2026: `getUserDefinedData()` devolvía el JSON CORTADO A MEDIAS
 * ("unexpected end of string", "expecting ']'"), o sea que esta memoria tiene un tope
 * de tamaño. Lo que abulta son `registro` (60 trabajos) y `vistos` (200 claves), que
 * son prescindibles; los usuarios, sus huellas, los contadores y los ajustes caben de
 * sobra. El registro completo vive en el fichero de `Object.save`, que no se corta.
 *
 * Perder `vistos` en esta copia significa que, si alguna vez hubiera que tirar SÓLO de
 * ella, algún trabajo viejo podría contarse dos veces. Es mucho menos malo que quedarse
 * sin la copia entera por no caber.
 */
function paraMemoria() {
    return {
        version: cache.version,
        usuarios: cache.usuarios,
        contadores: cache.contadores,
        historialIniciado: cache.historialIniciado,
        ajustes: cache.ajustes,
    };
}

/** El aviso de que la memoria no se deja releer se da una vez, no en cada guardado. */
let avisadoRelectura = false;

function guardarEnMemoria() {
    const s = ns();
    if (!s || typeof s.setUserDefinedData !== 'function') {
        return false;
    }
    try {
        // Se respeta lo que haya de otras apps, pero sólo si se puede leer: si la
        // lectura falla aquí, se escribe únicamente nuestra clave en vez de arrasar.
        let todo = {};
        try {
            todo = comoObjeto(s.getUserDefinedData()) || {};
        } catch (e) {
            if (!avisadoRelectura) {
                avisadoRelectura = true;
                console.log('[store] la memoria no se deja releer (' + (e && e.message)
                    + '): se escribe sólo ' + CLAVE + ' y manda el fichero');
            }
        }
        todo[CLAVE] = paraMemoria();
        s.setUserDefinedData(todo);
        return true;
    } catch (e) {
        console.log('[store] setUserDefinedData: ' + (e && e.message));
        return false;
    }
}

/**
 * La primera escritura se verifica releyéndola, en cada sitio por separado. Ninguna
 * de las dos APIs es de fiar por su retorno: `setUserDefinedData` devuelve un ERROR_NO
 * que la app ignoraba, y `Object.save` devuelve basura (-4.4e-95, medido). Así que la
 * única prueba de que algo se guardó es volver a leerlo.
 *
 * Se comprueba una vez y no en cada trabajo: releer en cada contada sale caro.
 */
function comprobarEscritura(enFichero, enMemoria) {
    let fichero = 'no se intentó';
    if (enFichero) {
        const d = leerFichero();
        fichero = d ? 'ok (' + d.usuarios.length + ' usuario(s))' : 'NO VUELVE';
    }
    let memoria = 'no se intentó';
    if (enMemoria) {
        try {
            const s = ns();
            const todo = comoObjeto(s.getUserDefinedData());
            const d = todo && todo[CLAVE];
            memoria = esNuestro(d) ? 'ok (' + d.usuarios.length + ' usuario(s))' : 'NO VUELVE';
        } catch (e) {
            memoria = 'al releer lanzó ' + (e && e.message);
        }
    }
    console.log('[store] primera escritura · fichero: ' + fichero + ' · memoria: ' + memoria);
}

/* ------------------------------------------------------------------ */
/* Respaldo: sacar todo y volver a meterlo                              */
/* ------------------------------------------------------------------ */

/**
 * Sube de uno en uno con cada guardado. Sirve para que el respaldo automático sepa si
 * hay algo nuevo y no repita el mismo envío cada media hora.
 */
let revision = 0;

export function revisionActual() {
    return revision;
}

/**
 * TODO lo guardado, para el respaldo. Incluye las huellas de los PIN: es lo que hace
 * que el respaldo sirva para restaurar, y también lo que lo vuelve sensible. Una
 * huella de un PIN de 4 dígitos se rompe probando las 10.000, así que este objeto
 * vale lo mismo que la lista de PIN en claro.
 */
export function respaldo() {
    const d = cargar();
    return {
        formato: 1,
        app: 'impresion-pin-BM5220ADW',
        revision,
        usuarios: d.usuarios,
        contadores: d.contadores,
        registro: d.registro,
        ajustes: d.ajustes,
    };
}

/**
 * Mete usuarios de un respaldo o de una lista preparada a mano.
 *
 * Acepta `{usuarios: [...]}` (un respaldo entero) o directamente `[...]`. Cada usuario
 * vale con `huella` (viene de un respaldo: el PIN sigue siendo el de antes) o con
 * `pin` (una lista escrita a mano: se calcula la huella aquí).
 *
 * NO borra a nadie: lo que ya existe se actualiza y lo que no, se crea. Borrar por
 * error a toda la plantilla desde un fichero mal escrito es un daño que no compensa.
 *
 * @returns {{ok: boolean, creados: number, actualizados: number, malos: number, error?: string}}
 */
export function restaurarUsuarios(entrada) {
    const lista = Array.isArray(entrada) ? entrada
        : (entrada && Array.isArray(entrada.usuarios) ? entrada.usuarios : null);
    if (!lista) {
        return { ok: false, creados: 0, actualizados: 0, malos: 0, error: 'El fichero no trae una lista de usuarios' };
    }
    const d = cargar();
    let creados = 0;
    let actualizados = 0;
    let malos = 0;
    for (const u of lista) {
        const n = normalizarUsuario(u && u.nombre);
        const huellaNueva = u && u.huella ? String(u.huella)
            : (u && pinValido(u.pin) ? huella(n, u.pin) : null);
        if (!usuarioValido(n) || n === SIN_SESION || !huellaNueva) {
            malos++;
            continue;
        }
        const ya = d.usuarios.filter((x) => x.nombre === n)[0];
        if (ya) {
            ya.huella = huellaNueva;
            ya.activo = u.activo === false ? false : true;
            actualizados++;
        } else {
            d.usuarios.push({
                nombre: n,
                huella: huellaNueva,
                activo: u.activo === false ? false : true,
                creado: u.creado || new Date().toISOString(),
            });
            creados++;
        }
        intentos.delete(n);
    }
    if (creados || actualizados) {
        guardar();
    }
    return { ok: creados + actualizados > 0, creados, actualizados, malos };
}

/** Solo para las pruebas: olvida la copia en memoria y relee del equipo. */
export function _recargar() {
    cache = null;
    intentos.clear();
    soloLectura = false;
    motivo = null;
    ultimoIntento = 0;
    escrituraComprobada = false;
    avisadoRelectura = false;
    revision = 0;
}

/* ------------------------------------------------------------------ */
/* Huellas                                                              */
/* ------------------------------------------------------------------ */

function fnv1a(texto, semilla) {
    let h = semilla >>> 0;
    for (let i = 0; i < texto.length; i++) {
        h ^= texto.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

export function huella(nombre, pin) {
    const t = 'impresion-pin|' + String(nombre) + '|' + String(pin);
    return fnv1a(t, 2166136261).toString(16) + fnv1a(t, 0x9747b28c).toString(16);
}

/* ------------------------------------------------------------------ */
/* Ajustes y administrador                                              */
/* ------------------------------------------------------------------ */

export function ajustes() {
    return cargar().ajustes;
}

export function cambiarAjuste(clave, valor) {
    cargar().ajustes[clave] = valor;
    guardar();
    return cache.ajustes;
}

export function esPinAdmin(pin) {
    if (!pin) {
        return false;
    }
    const h = cargar().ajustes.huellaAdmin;
    return h ? h === huella('#admin', pin) : String(pin) === config.PIN_ADMIN_FABRICA;
}

export function pinValido(pin) {
    const p = String(pin || '');
    return /^[0-9]+$/.test(p) && p.length >= config.PIN_MIN && p.length <= config.PIN_MAX;
}

export function cambiarPinAdmin(pin) {
    if (!pinValido(pin)) {
        return false;
    }
    cambiarAjuste('huellaAdmin', huella('#admin', pin));
    return true;
}

export function pinAdminDeFabrica() {
    return !cargar().ajustes.huellaAdmin;
}

/* ------------------------------------------------------------------ */
/* Usuarios                                                             */
/* ------------------------------------------------------------------ */

export function normalizarUsuario(texto) {
    return String(texto || '').trim().toLowerCase();
}

export function usuarioValido(texto) {
    const n = normalizarUsuario(texto);
    return n.length >= 1 && n.length <= config.USUARIO_MAX && /^[a-z0-9._-]+$/.test(n);
}

export function usuarios() {
    return cargar().usuarios.slice().sort((a, b) => (a.nombre < b.nombre ? -1 : 1));
}

function buscar(nombre) {
    const n = normalizarUsuario(nombre);
    return cargar().usuarios.filter((u) => u.nombre === n)[0] || null;
}

export function agregarUsuario(nombre, pin) {
    const n = normalizarUsuario(nombre);
    if (!usuarioValido(n)) {
        return { ok: false, error: 'Usuario no válido (a-z, 0-9, . _ -)' };
    }
    if (n === SIN_SESION) {
        return { ok: false, error: 'Nombre reservado' };
    }
    if (buscar(n)) {
        return { ok: false, error: 'Ese usuario ya existe' };
    }
    if (!pinValido(pin)) {
        return { ok: false, error: 'PIN de ' + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos' };
    }
    cargar().usuarios.push({ nombre: n, huella: huella(n, pin), activo: true, creado: new Date().toISOString() });
    guardar();
    return { ok: true };
}

export function cambiarPinUsuario(nombre, pin) {
    const u = buscar(nombre);
    if (!u || !pinValido(pin)) {
        return false;
    }
    u.huella = huella(u.nombre, pin);
    intentos.delete(u.nombre);
    guardar();
    return true;
}

export function activarUsuario(nombre, activo) {
    const u = buscar(nombre);
    if (!u) {
        return false;
    }
    u.activo = !!activo;
    guardar();
    return true;
}

/** Borra el usuario. Sus contadores se conservan hasta reiniciarlos. */
export function quitarUsuario(nombre) {
    const n = normalizarUsuario(nombre);
    const d = cargar();
    const antes = d.usuarios.length;
    d.usuarios = d.usuarios.filter((u) => u.nombre !== n);
    guardar();
    return d.usuarios.length < antes;
}

/** Intentos fallidos en memoria: {nombre: {fallos, hasta}}. Reiniciar la app los borra. */
const intentos = new Map();

/** Minutos que le quedan de bloqueo por intentos a ese nombre (0 si puede probar). */
export function esperaPorIntentos(nombre, ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    const reg = intentos.get(normalizarUsuario(nombre));
    return reg && reg.hasta > t ? Math.ceil((reg.hasta - t) / 60000) : 0;
}

/** Suma un fallo; al llegar al máximo bloquea ese nombre un rato. */
export function anotarFallo(nombre, ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    const n = normalizarUsuario(nombre);
    const reg = intentos.get(n);
    // Un bloqueo ya vencido no arrastra fallos: se empieza de cero.
    const r = reg && reg.hasta === 0 ? reg : { fallos: 0, hasta: 0 };
    r.fallos += 1;
    if (r.fallos >= config.INTENTOS_MAX) {
        r.hasta = t + config.BLOQUEO_INTENTOS_MS;
        r.fallos = 0;
    }
    intentos.set(n, r);
}

export function olvidarFallos(nombre) {
    intentos.delete(normalizarUsuario(nombre));
}

/**
 * ¿Usuario y PIN correctos?
 * @returns {{ok: boolean, error?: string, usuario?: string}}
 */
export function validarUsuario(nombre, pin, ahora) {
    const n = normalizarUsuario(nombre);
    const espera = esperaPorIntentos(n, ahora);
    if (espera > 0) {
        return { ok: false, error: 'Demasiados intentos. Espere ' + espera + ' min' };
    }
    const u = buscar(n);
    // El mismo mensaje para usuario inexistente y PIN malo: no se revela quién existe.
    if (!u || u.huella !== huella(n, pin)) {
        anotarFallo(n, ahora);
        return { ok: false, error: 'Usuario o PIN incorrecto' };
    }
    if (u.activo === false) {
        return { ok: false, error: 'Usuario desactivado' };
    }
    olvidarFallos(n);
    return { ok: true, usuario: u.nombre };
}

/* ------------------------------------------------------------------ */
/* Contadores                                                           */
/* ------------------------------------------------------------------ */

/**
 * Suma un trabajo del historial a una persona (o a SIN_SESION).
 * @param {string} quien
 * @param {{tipo: string, paginas: number, doc?: string, estado?: string, hora?: string, origen?: string}} t
 */
export function contar(quien, t) {
    const d = cargar();
    const clave = String(quien || SIN_SESION);
    const c = d.contadores[clave] || { impresiones: 0, paginas: 0, copias: 0, paginasCopia: 0 };
    const paginas = Math.max(0, Number(t.paginas) || 0);
    if (t.tipo === 'COPY') {
        c.copias += 1;
        c.paginasCopia += paginas;
    } else {
        c.impresiones += 1;
        c.paginas += paginas;
    }
    d.contadores[clave] = c;
    d.registro.unshift({
        hora: t.hora || new Date().toISOString().slice(0, 19).replace('T', ' '),
        quien: clave,
        tipo: t.tipo === 'COPY' ? 'COPY' : 'PRINT',
        paginas,
        doc: t.doc ? String(t.doc).slice(0, 40) : null,
        estado: t.estado || null,
        origen: t.origen ? String(t.origen).slice(0, 30) : null,
    });
    if (d.registro.length > config.REGISTRO_MAX) {
        d.registro = d.registro.slice(0, config.REGISTRO_MAX);
    }
    guardar();
    return c;
}

/** [{quien, impresiones, paginas, copias, paginasCopia}] ordenado por páginas. */
export function contadores() {
    const c = cargar().contadores;
    return Object.keys(c)
        .map((quien) => Object.assign({ quien }, c[quien]))
        .sort((a, b) => (b.paginas + b.paginasCopia) - (a.paginas + a.paginasCopia));
}

export function contadorDe(quien) {
    return cargar().contadores[quien] || { impresiones: 0, paginas: 0, copias: 0, paginasCopia: 0 };
}

export function totales() {
    return contadores().reduce((s, r) => {
        s.impresiones += r.impresiones;
        s.paginas += r.paginas;
        s.copias += r.copias;
        s.paginasCopia += r.paginasCopia;
        return s;
    }, { impresiones: 0, paginas: 0, copias: 0, paginasCopia: 0 });
}

export function registro() {
    return cargar().registro.slice();
}

export function reiniciarContadores() {
    const d = cargar();
    d.contadores = {};
    d.registro = [];
    guardar();
}

/* ------------------------------------------------------------------ */
/* Trabajos ya contados                                                 */
/* ------------------------------------------------------------------ */

export function historialIniciado() {
    return cargar().historialIniciado;
}

export function yaVisto(clave) {
    return cargar().vistos.indexOf(String(clave)) >= 0;
}

/** Marca claves como contadas; `iniciar` marca además el arranque del historial. */
export function marcarVistos(claves, iniciar) {
    const d = cargar();
    for (const c of claves) {
        if (d.vistos.indexOf(String(c)) < 0) {
            d.vistos.push(String(c));
        }
    }
    if (d.vistos.length > config.VISTOS_MAX) {
        d.vistos = d.vistos.slice(d.vistos.length - config.VISTOS_MAX);
    }
    if (iniciar) {
        d.historialIniciado = true;
    }
    guardar();
}
