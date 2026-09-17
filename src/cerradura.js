/**
 * La cerradura: los interruptores de función del propio equipo
 * (`pedk.device.setting.setFunctionSwitch`).
 *
 * Fuera de sesión se apaga la impresión que llega de un PC —por red y por cable USB—
 * y, si el administrador lo pide, la copia desde el panel. Al entrar alguien con su
 * usuario y PIN se enciende, y al salir se vuelve a apagar.
 *
 * Lo que está MEDIDO en la BM5220ADW (27-08-2026, agente de CloudPrint):
 * `getFunctionSwitch` contesta `FUNC_SW_ON` para `FUNC_T_USBPORT_PRINT`, `FUNC_T_COPY`,
 * `FUNC_T_IDCOPY` y `FUNC_T_BILL`. Lo que NO está medido: que `FUNC_T_NET_PRINT` exista
 * en este firmware y que apagarlo impida de verdad imprimir desde un PC. Por eso:
 *
 *  - después de cada cambio se RELEE el interruptor, y sólo lo que el equipo dice
 *    tener puesto cuenta como hecho. Que `setFunctionSwitch` no lance no prueba nada;
 *  - la pantalla de diagnóstico trae una prueba con un trabajo real
 *    (ver diagnostico.js), porque leer el interruptor tampoco prueba que bloquee.
 *
 * `FUNC_T_NET_COMMUNICATION` no se toca NUNCA: apagaría la red entera.
 */

const IMPRESION = ['FUNC_T_NET_PRINT', 'FUNC_T_USBPORT_PRINT'];
const COPIA = ['FUNC_T_COPY', 'FUNC_T_IDCOPY', 'FUNC_T_BILL'];

/** El que tiene que quedar apagado para dar el equipo por bloqueado. */
const PRINCIPAL = 'FUNC_T_NET_PRINT';

export const INTERRUPTORES = { IMPRESION, COPIA, PRINCIPAL };

function ajustesNs() {
    return (globalThis.pedk && pedk.device && pedk.device.setting) || null;
}

export function disponible() {
    const s = ajustesNs();
    return !!(s && typeof s.setFunctionSwitch === 'function' && typeof s.getFunctionSwitch === 'function');
}

/** Las constantes del SDK son cadenas iguales a su nombre: se usa el literal si falta. */
function clave(nombre) {
    const s = ajustesNs();
    const tipos = (s && s.FUNCTION_TYPE) || {};
    return tipos[nombre] || nombre;
}

function valor(encendido) {
    const s = ajustesNs();
    const sw = (s && s.FUNCTION_SWITCH) || {};
    return encendido ? (sw.FUNC_SW_ON || 'FUNC_SW_ON') : (sw.FUNC_SW_OFF || 'FUNC_SW_OFF');
}

/** ¿El firmware EXPORTA la constante? No dice si la acepta, sólo si la conoce. */
export function exportado(nombre) {
    const s = ajustesNs();
    return !!(s && s.FUNCTION_TYPE && s.FUNCTION_TYPE[nombre]);
}

/**
 * Lee un interruptor.
 * @returns {boolean|null} true encendido, false apagado, null si no se puede saber
 */
export function leer(nombre) {
    const s = ajustesNs();
    if (!s || typeof s.getFunctionSwitch !== 'function') {
        return null;
    }
    try {
        return interpretar(s.getFunctionSwitch(clave(nombre)));
    } catch (e) {
        return null;
    }
}

/** Texto crudo, para el diagnóstico. */
export function leerCrudo(nombre) {
    const s = ajustesNs();
    if (!s || typeof s.getFunctionSwitch !== 'function') {
        return 'sin getFunctionSwitch';
    }
    try {
        return String(s.getFunctionSwitch(clave(nombre)));
    } catch (e) {
        return 'lanzó ' + String((e && e.message) || e).slice(0, 40);
    }
}

function interpretar(v) {
    if (v === true || v === false) {
        return v;
    }
    const t = String(v === null || v === undefined ? '' : v).toUpperCase();
    if (/(^|_)OFF$/.test(t)) {
        return false;
    }
    if (/(^|_)ON$/.test(t)) {
        return true;
    }
    return null;
}

/**
 * Pone un interruptor y relee.
 * @returns {{nombre, pedido: boolean, antes, despues, ok: boolean, error: string|null}}
 */
export function poner(nombre, encendido) {
    const s = ajustesNs();
    const r = { nombre, pedido: !!encendido, antes: leer(nombre), despues: null, ok: false, error: null };
    if (!s || typeof s.setFunctionSwitch !== 'function') {
        r.error = 'sin setFunctionSwitch';
        return r;
    }
    try {
        const ret = s.setFunctionSwitch(clave(nombre), valor(encendido));
        if (ret !== undefined && ret !== null && /FAIL|ERR|INVALID|NOTSUP/i.test(String(ret))) {
            r.error = String(ret).slice(0, 40);
        }
    } catch (e) {
        r.error = String((e && e.message) || e).slice(0, 40);
    }
    r.despues = leer(nombre);
    r.ok = r.despues === !!encendido;
    console.log('[cerradura] ' + nombre + ' -> ' + (encendido ? 'ON' : 'OFF')
        + ' · antes ' + r.antes + ' · después ' + r.despues + (r.error ? ' · ' + r.error : ''));
    return r;
}

function aplicar(nombres, encendido) {
    return nombres.map((n) => poner(n, encendido));
}

function resumir(detalles, encendido) {
    const fallidos = detalles.filter((d) => !d.ok).map((d) => d.nombre.replace('FUNC_T_', ''));
    return fallidos.length === 0
        ? (encendido ? 'Equipo desbloqueado' : 'Equipo bloqueado')
        : 'Sin confirmar: ' + fallidos.join(', ');
}

/**
 * Bloquea. `ok` exige que la impresión de red quede apagada según el propio equipo;
 * el resto (USB, copia) se informa en `detalles` pero no invalida el bloqueo.
 * @param {{impresion?: boolean, copia?: boolean}} que
 */
export function cerrar(que) {
    const q = Object.assign({ impresion: true, copia: false }, que);
    const detalles = [];
    if (q.impresion) {
        detalles.push(...aplicar(IMPRESION, false));
    }
    if (q.copia) {
        detalles.push(...aplicar(COPIA, false));
    }
    const principal = detalles.filter((d) => d.nombre === PRINCIPAL)[0];
    const ok = q.impresion ? !!(principal && principal.ok) : detalles.every((d) => d.ok);
    return { ok, detalles, resumen: resumir(detalles, false) };
}

/**
 * Desbloquea. Por defecto abre TODO (impresión y copia): es también la marcha atrás,
 * así que no pregunta ni comprueba nada antes.
 */
export function abrir(que) {
    const q = Object.assign({ impresion: true, copia: true }, que);
    const detalles = [];
    if (q.impresion) {
        detalles.push(...aplicar(IMPRESION, true));
    }
    if (q.copia) {
        detalles.push(...aplicar(COPIA, true));
    }
    return { ok: detalles.every((d) => d.ok), detalles, resumen: resumir(detalles, true) };
}

/**
 * ¿Está bloqueada la impresión desde PC ahora mismo?
 * @returns {boolean|null} null si el equipo no deja saberlo
 */
export function impresionBloqueada() {
    const v = leer(PRINCIPAL);
    return v === null ? null : v === false;
}

/** ¿Hay algún interruptor nuestro apagado? (para desbloquear tras reinstalar) */
export function algoApagado() {
    return IMPRESION.concat(COPIA).some((n) => leer(n) === false);
}
