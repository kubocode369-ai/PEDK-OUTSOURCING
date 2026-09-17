/**
 * Exploración del firmware: qué expone de verdad sobre la impresión segura.
 *
 * Medido el 15-09-2026 en la BM5220ADW: la impresión segura del driver se retiene y se
 * libera en IM SGR (menú del equipo), pero `new pedk.jobs.print.EncryptJobPrint()`
 * lanza "not a function". Sin esa clase la app no puede listar ni liberar lo retenido,
 * y la persona tiene que identificarse en IM SGR además de en la app.
 *
 * La implementación de `pedk` en el equipo es JavaScript del propio firmware
 * (el log carga /pesf/inner/*.js). Su fuente se puede leer con toString(): así se ve
 * qué función nativa llama EncryptJobPrint, cuál falta, y si hay otra vía (enlaces
 * globales `js_*`) para listar y liberar trabajos retenidos desde la app.
 *
 * Todo va a la consola con el prefijo [explorar]; al panel sólo llega un resumen.
 */

const TROZO = 800;
const MAX_FUENTE = 12000;
const INTERES = /encrypt|secure|secret|confiden|hold|retain|reten|passw|pin_?code|job_?list|joblist/i;

function log(seccion, texto) {
    const s = String(texto);
    const n = Math.max(1, Math.ceil(s.length / TROZO));
    for (let i = 0; i < n; i++) {
        console.log('[explorar] ' + seccion + (n > 1 ? ' ' + (i + 1) + '/' + n : '') + ': ' + s.substr(i * TROZO, TROZO));
    }
}

function nombres(obj) {
    if (obj === null || obj === undefined) {
        return [];
    }
    try {
        return Object.getOwnPropertyNames(obj);
    } catch (e) {
        return [];
    }
}

function tipo(obj, clave) {
    try {
        return typeof obj[clave];
    } catch (e) {
        return 'lanza';
    }
}

function fuente(fn) {
    try {
        const s = Function.prototype.toString.call(fn);
        return s.length > MAX_FUENTE ? s.substring(0, MAX_FUENTE) + ' …[recortado de ' + s.length + ']' : s;
    } catch (e) {
        return '(sin fuente: ' + (e && e.message) + ')';
    }
}

/** Fuente de una función y de los métodos de su prototipo, al log. */
function volcarClase(nombre, Clase) {
    log(nombre + '.fuente', fuente(Clase));
    const proto = Clase && Clase.prototype;
    for (const m of nombres(proto)) {
        if (m !== 'constructor' && tipo(proto, m) === 'function') {
            log(nombre + '.' + m, fuente(proto[m]));
        }
    }
    const base = Clase ? Object.getPrototypeOf(Clase) : null;
    if (typeof base === 'function' && base !== Function.prototype) {
        log(nombre + '.base', fuente(base));
        for (const m of nombres(base.prototype)) {
            if (m !== 'constructor' && tipo(base.prototype, m) === 'function') {
                log(nombre + '.base.' + m, fuente(base.prototype[m]));
            }
        }
    }
    for (const m of nombres(Clase)) {
        if (!/^(length|name|prototype|caller|arguments)$/.test(m)) {
            log(nombre + '.estatico.' + m, tipo(Clase, m) === 'function' ? fuente(Clase[m]) : tipo(Clase, m));
        }
    }
}

/**
 * Hace el volcado completo y devuelve líneas cortas para el panel.
 * @returns {string[]}
 */
export function volcar() {
    const out = [];
    const g = globalThis;

    const globales = nombres(g);
    const nativas = globales.filter((k) => /^js_/.test(k));
    log('globales', globales.join(','));
    out.push('Globales: ' + globales.length + ' · js_*: ' + nativas.length);

    const interesantes = globales.filter((k) => INTERES.test(k));
    log('globales de interes', interesantes.join(',') || 'ninguna');
    out.push('Globales seguras: ' + (interesantes.join(',') || 'ninguna'));
    for (const k of interesantes) {
        if (tipo(g, k) === 'function') {
            log('global.' + k, fuente(g[k]));
        }
    }

    const pedk = g.pedk;
    log('pedk', nombres(pedk).join(','));
    const print = pedk && pedk.jobs && pedk.jobs.print;
    log('pedk.jobs.print', nombres(print).join(','));
    log('pedk.jobctl', nombres(pedk && pedk.jobctl).join(','));

    const Ejp = print && print.EncryptJobPrint;
    out.push('EncryptJobPrint: ' + typeof Ejp + (Ejp ? ' · fuente ' + fuente(Ejp).length + ' car.' : ''));
    if (typeof Ejp === 'function') {
        volcarClase('EncryptJobPrint', Ejp);
        try {
            const j = new Ejp();
            out.push('new EncryptJobPrint(): funciona');
            log('instancia', nombres(j).concat(nombres(Object.getPrototypeOf(j))).join(','));
            try {
                log('getUserNameList()', JSON.stringify(j.getUserNameList()));
            } catch (e) {
                log('getUserNameList() lanzó', (e && e.stack) || e);
            }
        } catch (e) {
            const msg = String((e && e.message) || e);
            out.push('new EncryptJobPrint(): ' + msg.slice(0, 40));
            log('new EncryptJobPrint() lanzó', msg + ' | pila: ' + ((e && e.stack) || 'sin pila'));
        }
    }

    // Otras piezas del SDK que tocan la impresión segura o los trabajos.
    for (const [nombre, valor] of [['PrintJob base', print && print.PrintJob], ['JobInfo', pedk && pedk.jobctl && pedk.jobctl.JobInfo]]) {
        if (typeof valor === 'function') {
            volcarClase(nombre, valor);
        }
    }

    out.push('Detalle completo en el log: [explorar]');
    return out;
}
