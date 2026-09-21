/**
 * Cambios de ajustes que tocan el EQUIPO, compartidos por el panel (ajustes.js) y la
 * web (web.js). Cambiar el modo o el bloqueo no es sólo guardar un valor: hay que
 * dejar los interruptores de la impresora como corresponde, y si no se puede, deshacer
 * (un bloqueo a medias es peor que ninguno: da falsa seguridad). Esa lógica vive aquí
 * una sola vez para que el panel y la web no puedan acabar haciendo cosas distintas.
 *
 * Cada acción devuelve {ok, texto, nivel} — nivel: 'ok' | 'aviso' | 'error' — y quien
 * la llama decide cómo enseñarlo.
 */
import { config } from './config.js';
import * as store from './store.js';
import * as cerradura from './cerradura.js';
import * as sesion from './sesion.js';
import * as retencion from './retencion.js';

const oyentes = [];

/** Para que la pantalla de inicio se entere de un cambio hecho desde la web. */
export function alCambiar(fn) {
    oyentes.push(fn);
}

function avisar() {
    oyentes.forEach((fn) => {
        try { fn(); } catch (e) { console.log('[acciones] oyente: ' + (e && e.message)); }
    });
}

function res(ok, texto, nivel) {
    return { ok, texto, nivel: nivel || (ok ? 'ok' : 'error') };
}

/**
 * Con alguien usando la impresora, cambiar modo o bloqueo le cerraría la puerta a
 * mitad de su trabajo (reposo() bloquea como si no hubiera nadie). En el panel no pasa
 * porque para entrar en Ajustes no puede haber una sesión abierta; en la web sí.
 */
function ocupada() {
    return sesion.activa()
        ? res(false, 'Hay una persona usando la impresora (' + sesion.usuario() + '). Inténtelo en unos minutos.')
        : null;
}

/** Para lo que no debe hacerse con alguien imprimiendo (p. ej. la prueba de capacidad). */
export function impresoraOcupada() {
    return ocupada();
}

export function fijarBloqueo(encender) {
    const a = store.ajustes();
    if (!!encender === !!a.bloqueoActivo) {
        return res(true, encender ? 'El bloqueo ya estaba encendido' : 'El bloqueo ya estaba apagado', 'aviso');
    }
    if (!encender) {
        store.cambiarAjuste('bloqueoActivo', false);
        const r = cerradura.abrir();
        avisar();
        return r.ok ? res(true, 'Bloqueo apagado: cualquiera imprime', 'aviso') : res(false, r.resumen);
    }
    // Apagar con alguien dentro no le hace daño (sólo abre); encender, sí.
    const o = ocupada();
    if (o) return o;
    if (store.usuarios().filter((u) => u.activo !== false).length === 0) {
        return res(false, 'Dé de alta al menos un usuario antes');
    }
    store.cambiarAjuste('bloqueoActivo', true);
    const r = sesion.reposo();
    if (!r.ok) {
        store.cambiarAjuste('bloqueoActivo', false);
        cerradura.abrir();
        avisar();
        return res(false, 'No se pudo bloquear: ' + r.resumen);
    }
    avisar();
    return a.modo === 'retencion'
        ? res(true, 'Activo: sólo se imprime con usuario y PIN')
        : res(true, 'Bloqueado. Compruébelo con Diagnóstico > Probar');
}

export function fijarModo(modo) {
    if (modo !== 'sesion' && modo !== 'retencion') {
        return res(false, 'Modo desconocido');
    }
    if (store.ajustes().modo === modo) {
        return res(true, 'Ya estaba en modo ' + (modo === 'sesion' ? 'sesión' : 'retención'), 'aviso');
    }
    const o = ocupada();
    if (o) return o;
    let r;
    if (modo === 'sesion') {
        store.cambiarAjuste('modo', 'sesion');
        r = res(true, 'Modo sesión: se desbloquea al entrar');
    } else {
        let d = retencion.disponible();
        if (!d.ok) {
            retencion.encenderFuncion();
            d = retencion.disponible();
        }
        if (!d.ok) {
            return res(false, 'Este equipo no retiene: ' + d.detalle);
        }
        store.cambiarAjuste('modo', 'retencion');
        r = res(true, 'Modo retención: el PC envía como confidencial');
    }
    sesion.reposo();
    avisar();
    return r;
}

export function fijarMinutosSesion(minutos) {
    const n = Number(minutos);
    if (config.MINUTOS_SESION_OPCIONES.indexOf(n) < 0) {
        return res(false, 'Duración no válida');
    }
    store.cambiarAjuste('minutosSesion', n);
    return res(true, 'Sesión de ' + n + ' min');
}

export function fijarBloqueoCopia(bloquear) {
    const a = store.ajustes();
    store.cambiarAjuste('bloquearCopia', !!bloquear);
    if (!a.bloqueoActivo) {
        return res(true, bloquear ? 'Copia con PIN: se aplicará al encender el bloqueo' : 'Copia libre', 'aviso');
    }
    const r = bloquear ? cerradura.cerrar({ impresion: false, copia: true }) : cerradura.abrir({ impresion: false, copia: true });
    avisar();
    return res(r.ok, r.resumen);
}

export function desbloquearTodo() {
    store.cambiarAjuste('bloqueoActivo', false);
    const r = cerradura.abrir();
    avisar();
    return r.ok ? res(true, 'Equipo desbloqueado y bloqueo apagado') : res(false, r.resumen);
}
