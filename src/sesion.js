/**
 * Quién está usando el equipo, y a quién se le carga cada trabajo del historial.
 *
 * Regla de atribución (la misma en los dos modos):
 *   - con una sesión abierta, todo lo que aparezca en el historial es de esa persona;
 *   - hasta GRACIA_MS después de cerrarla, sigue siendo suyo (el documento pudo
 *     mandarse antes de pulsar "Terminar" y salir después);
 *   - fuera de eso va a SIN_SESION. Con el bloqueo encendido ese contador debería
 *     quedarse en cero: si sube, la cerradura no está funcionando.
 *
 * Límite honesto: en modo sesión, si otra persona manda algo desde su PC mientras la
 * sesión está abierta, se le carga a quien la abrió. El equipo no dice de qué PC
 * vino con certeza (`host_name` suele venir vacío), así que no hay con qué separarlo.
 */
import { config } from './config.js';
import * as store from './store.js';
import * as cerradura from './cerradura.js';

let actual = null;     // {usuario, desde, ultimaActividad, pin}
let anterior = null;   // {usuario, hasta}

export function activa() {
    return actual !== null;
}

export function usuario() {
    return actual ? actual.usuario : null;
}

/** Sólo existe en modo retención, mientras dura la sesión. Nunca se guarda. */
export function pin() {
    return actual ? actual.pin : null;
}

function duracionMs() {
    return store.ajustes().minutosSesion * 60 * 1000;
}

/**
 * Lo que dejamos bloqueado fuera de sesión, según los ajustes. En modo RETENCIÓN la
 * impresión de red NO se apaga (mataría también la impresión segura): de que sólo se
 * imprima con usuario y PIN se encarga el guardián (vigia.js), no el interruptor.
 */
function queBloquear() {
    const a = store.ajustes();
    return { impresion: a.modo !== 'retencion', copia: a.bloquearCopia };
}

/**
 * Abre la sesión. En modo sesión con el bloqueo encendido, desbloquea el equipo; si
 * el equipo no confirma el desbloqueo, la sesión no se abre (no tendría sentido
 * dejar a alguien "dentro" sin poder imprimir).
 * @returns {{ok: boolean, error?: string, aviso?: string}}
 */
export function abrir(nombre, pinTexto, ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    const a = store.ajustes();
    if (a.bloqueoActivo) {
        const que = a.modo === 'sesion'
            ? { impresion: true, copia: a.bloquearCopia }
            : { impresion: false, copia: a.bloquearCopia };
        if (que.impresion || que.copia) {
            const r = cerradura.abrir(que);
            if (!r.ok) {
                cerradura.cerrar(queBloquear());
                return { ok: false, error: 'El equipo no se desbloqueó: ' + r.resumen };
            }
        }
    }
    actual = { usuario: nombre, desde: t, ultimaActividad: t, pin: a.modo === 'retencion' ? pinTexto : null };
    anterior = null;
    console.log('[sesion] abierta: ' + nombre + ' (' + a.modo + ')');
    return { ok: true, aviso: a.bloqueoActivo ? null : 'Bloqueo apagado: el equipo imprime sin PIN' };
}

/**
 * Cierra la sesión y vuelve a bloquear.
 * @returns {{ok: boolean, resumen: string}} ok=false si el equipo no quedó bloqueado
 */
export function cerrar(motivo, ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    if (actual) {
        console.log('[sesion] cerrada: ' + actual.usuario + ' (' + (motivo || 'salir') + ')');
        anterior = { usuario: actual.usuario, hasta: t };
        actual = null;
    }
    return reposo();
}

/** Deja el equipo como debe estar SIN nadie dentro. Se llama también al arrancar. */
export function reposo() {
    const a = store.ajustes();
    if (a.bloqueoActivo) {
        const r = cerradura.cerrar(queBloquear());
        return { ok: r.ok, resumen: r.resumen };
    }
    // Bloqueo apagado: si quedó algo apagado (p. ej. tras reinstalar la app, que borra
    // los ajustes pero no los interruptores del equipo), se abre. Es la vía de rescate.
    if (cerradura.disponible() && cerradura.algoApagado()) {
        const r = cerradura.abrir();
        return { ok: r.ok, resumen: r.resumen };
    }
    return { ok: true, resumen: 'Bloqueo apagado' };
}

export function actividad(ahora) {
    if (actual) {
        actual.ultimaActividad = typeof ahora === 'number' ? ahora : Date.now();
    }
}

export function restanteMs(ahora) {
    if (!actual) {
        return 0;
    }
    const t = typeof ahora === 'number' ? ahora : Date.now();
    return Math.max(0, actual.ultimaActividad + duracionMs() - t);
}

export function vencida(ahora) {
    return actual !== null && restanteMs(ahora) === 0;
}

/** ¿Acaba de cerrarse una sesión y todavía corre su tiempo de gracia? */
export function enGracia(ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    return actual === null && anterior !== null && t - anterior.hasta <= config.GRACIA_MS;
}

/** A quién se le carga un trabajo que aparece ahora en el historial. */
export function quienUsa(ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    if (actual) {
        return actual.usuario;
    }
    if (anterior && t - anterior.hasta <= config.GRACIA_MS) {
        return anterior.usuario;
    }
    return store.SIN_SESION;
}

/** Solo para las pruebas. */
export function _reiniciar() {
    actual = null;
    anterior = null;
}
