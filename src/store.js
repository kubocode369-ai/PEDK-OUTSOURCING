/**
 * Memoria del equipo (`pedk.device.storage`): usuarios, contadores, registro y
 * ajustes. No hay servidor: esto es la fuente de verdad.
 *
 * Dos cosas medidas en la BM5220ADW que mandan en este archivo:
 *
 *  - `setUserDefinedData` REEMPLAZA el objeto entero, no lo mezcla. Por eso se
 *    guarda todo bajo una sola clave y se respeta lo que haya en las demás.
 *  - **Reinstalar la app BORRA estos datos** (comprobado el 15-08-2026 con el agente
 *    de CloudPrint). Usuarios y contadores se pierden al actualizar la app: hay que
 *    anotar los contadores antes de reinstalar.
 *
 * De los PIN sólo se guarda una huella. No es criptografía seria —este motor no trae
 * `crypto`, y un PIN de 4 dígitos se adivina probando—; lo que protege de verdad es
 * el límite de intentos.
 */
import { config } from './config.js';

const CLAVE = 'impresionPin';

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
 * Lee la memoria del equipo.
 * @returns {?object} lo guardado bajo CLAVE, o null si no había nada.
 * @throws si el equipo no deja leer (lo que NUNCA debe confundirse con "no hay nada").
 */
function leerDelEquipo() {
    const s = ns();
    if (!s || typeof s.getUserDefinedData !== 'function') {
        // Sin API no hay nada que proteger: no se puede leer ni escribir.
        return null;
    }
    const todo = s.getUserDefinedData();
    if (todo === null || todo === undefined) {
        return null;                    // equipo nuevo: legítimamente vacío
    }
    if (typeof todo !== 'object') {
        // La doc del SDK dice que estas funciones devuelven un ERROR_NO (String)
        // cuando fallan. Un string aquí es un fallo, no una memoria vacía.
        throw new Error('devolvió ' + typeof todo + ': ' + String(todo).slice(0, 40));
    }
    return todo[CLAVE] || null;
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
    }
    return base;
}

/** Si ya se comprobó que una escritura llega de verdad al equipo. */
let escrituraComprobada = false;

function guardar() {
    const s = ns();
    if (!s || typeof s.setUserDefinedData !== 'function') {
        return false;
    }
    if (soloLectura) {
        console.log('[store] NO se guarda: la memoria no se pudo leer (' + motivo + ')');
        return false;
    }
    try {
        // Se respeta lo que haya de otras apps, pero sólo si se puede leer: si la
        // lectura falla aquí, se escribe únicamente nuestra clave en vez de arrasar.
        let todo = {};
        try {
            const leido = leerTodo(s);
            if (leido) {
                todo = leido;
            }
        } catch (e) {
            console.log('[store] no se pudo releer al guardar (' + (e && e.message) + '): se escribe sólo ' + CLAVE);
        }
        todo[CLAVE] = cache;
        const r = s.setUserDefinedData(todo);
        if (!escrituraComprobada) {
            comprobarEscritura(s, r);
        }
        return true;
    } catch (e) {
        console.log('[store] no se pudo guardar: ' + (e && e.message));
        return false;
    }
}

function leerTodo(s) {
    if (typeof s.getUserDefinedData !== 'function') {
        return null;
    }
    const leido = s.getUserDefinedData();
    if (leido === null || leido === undefined) {
        return null;
    }
    if (typeof leido !== 'object') {
        throw new Error('devolvió ' + typeof leido + ': ' + String(leido).slice(0, 40));
    }
    return leido;
}

/**
 * La primera escritura se verifica releyéndola. `setUserDefinedData` devuelve un
 * ERROR_NO que la app ignoraba, así que un guardado que fallaba en silencio se veía
 * bien en pantalla (el cache en RAM sí tenía los datos) y se perdía al apagar.
 * Se comprueba una vez y no en cada trabajo: releer en cada contada sale caro.
 */
function comprobarEscritura(s, resultado) {
    escrituraComprobada = true;
    let vuelta = null;
    try {
        vuelta = leerTodo(s);
    } catch (e) {
        console.log('[store] AVISO: setUserDefinedData devolvió "' + resultado
            + '" pero al releer: ' + (e && e.message));
        return;
    }
    const d = vuelta && vuelta[CLAVE];
    const ok = !!d && Array.isArray(d.usuarios);
    console.log('[store] primera escritura: devolvió "' + resultado + '" · al releer '
        + (ok ? 'están los datos (' + d.usuarios.length + ' usuario(s))' : 'NO ESTÁN LOS DATOS'));
}

/** Solo para las pruebas: olvida la copia en memoria y relee del equipo. */
export function _recargar() {
    cache = null;
    intentos.clear();
    soloLectura = false;
    motivo = null;
    ultimoIntento = 0;
    escrituraComprobada = false;
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
