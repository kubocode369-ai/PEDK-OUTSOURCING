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

function cargar() {
    if (cache) {
        return cache;
    }
    let guardado = null;
    const s = ns();
    if (s && typeof s.getUserDefinedData === 'function') {
        try {
            const todo = s.getUserDefinedData();
            guardado = todo && typeof todo === 'object' ? todo[CLAVE] : null;
        } catch (e) {
            console.log('[store] no se pudo leer: ' + (e && e.message));
        }
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

function guardar() {
    const s = ns();
    if (!s || typeof s.setUserDefinedData !== 'function') {
        return false;
    }
    try {
        let todo = {};
        if (typeof s.getUserDefinedData === 'function') {
            const leido = s.getUserDefinedData();
            todo = leido && typeof leido === 'object' ? leido : {};
        }
        todo[CLAVE] = cache;
        s.setUserDefinedData(todo);
        return true;
    } catch (e) {
        console.log('[store] no se pudo guardar: ' + (e && e.message));
        return false;
    }
}

/** Solo para las pruebas: olvida la copia en memoria y relee del equipo. */
export function _recargar() {
    cache = null;
    intentos.clear();
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
