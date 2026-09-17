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

/**
 * Lo que se busca para el respaldo de los datos: otra forma de guardar que sobreviva
 * al apagón, y cualquier acceso a ficheros (una flash, una descarga por red).
 */
const INTERES_DATOS = /storage|file|save|load|udisk|usb|mount|wget|upload|export|import|fs_/i;

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

/* ------------------------------------------------------------------ */
/* Respaldo de los datos: ¿dónde más se puede guardar, y qué hay del USB? */
/* ------------------------------------------------------------------ */

/** Recorre `pedk` dos niveles y anota las funciones que suenan a datos o ficheros. */
function buscarPorNombre(raiz, regex) {
    const hallados = [];
    for (const a of nombres(raiz)) {
        let n1 = null;
        try { n1 = raiz[a]; } catch (e) { continue; }
        if (regex.test(a)) {
            hallados.push('pedk.' + a + ' (' + tipo(raiz, a) + ')');
        }
        if (!n1 || typeof n1 !== 'object') {
            continue;
        }
        for (const b of nombres(n1)) {
            if (regex.test(b)) {
                hallados.push('pedk.' + a + '.' + b + ' (' + tipo(n1, b) + ')');
            }
            let n2 = null;
            try { n2 = n1[b]; } catch (e) { continue; }
            if (!n2 || typeof n2 !== 'object') {
                continue;
            }
            for (const c of nombres(n2)) {
                if (regex.test(c)) {
                    hallados.push('pedk.' + a + '.' + b + '.' + c + ' (' + tipo(n2, c) + ')');
                }
            }
        }
    }
    return hallados;
}

/**
 * Prueba de ida y vuelta de `Object.save`/`Object.load`: es la vía que la doc del SDK
 * recomienda para persistir, y la app todavía no la usa. Escribe en un fichero APARTE
 * (nunca sobre los datos de la app) con una marca de tiempo, y lo relee.
 *
 * Que aquí salga "ok" NO prueba que aguante un apagón: hay que volver a pulsar
 * Explorar SDK después de apagar y encender y comparar la marca. Por eso se registra.
 */
function probarObjectSave(out) {
    const O = globalThis.Object;
    const tieneSave = typeof O.save === 'function';
    const tieneLoad = typeof O.load === 'function';
    out.push('Object.save/load: ' + (tieneSave ? 'sí' : 'no') + '/' + (tieneLoad ? 'sí' : 'no'));
    if (!tieneSave || !tieneLoad) {
        return;
    }
    for (const nombre of ['pedk_prueba.json', '/storage/pedk_prueba.json']) {
        const marca = 'm' + Date.now();
        let r = null;
        try {
            r = O.save(nombre, { marca, nota: 'prueba de persistencia' });
        } catch (e) {
            out.push('save ' + nombre + ': lanzó ' + String((e && e.message) || e).slice(0, 24));
            continue;
        }
        let leido = null;
        try {
            leido = O.load(nombre);
        } catch (e) {
            out.push('load ' + nombre + ': lanzó ' + String((e && e.message) || e).slice(0, 24));
            continue;
        }
        const vale = leido && leido.marca === marca;
        // La marca ANTERIOR es la que importa tras un apagón: se deja en el log.
        log('Object.save ' + nombre, 'devolvió ' + r + ' · releído ' + JSON.stringify(leido)
            + ' · marca escrita ' + marca);
        out.push('save/load ' + nombre + ': ' + (vale ? 'ok (' + marca + ')' : 'NO vuelve igual'));
    }
}

/**
 * Qué devuelve de verdad `setUserDefinedData`, que hoy la app ignora. Reescribe el
 * objeto TAL CUAL se leyó —no cambia nada— sólo para ver el resultado, y sólo si la
 * lectura dio un objeto: si falló, escribir sería justo lo que borra los usuarios.
 */
function probarMemoriaApp(out) {
    const s = globalThis.pedk && pedk.device && pedk.device.storage;
    if (!s) {
        out.push('pedk.device.storage: no existe');
        return;
    }
    out.push('storage: ' + nombres(s).join(',').slice(0, 54));
    let leido = null;
    let fallo = null;
    try {
        leido = s.getUserDefinedData();
    } catch (e) {
        fallo = String((e && e.message) || e);
    }
    const esObjeto = !!leido && typeof leido === 'object';
    out.push('getUserDefinedData: ' + (fallo ? 'LANZÓ ' + fallo.slice(0, 30) : typeof leido)
        + (esObjeto ? ' · claves ' + nombres(leido).join(',').slice(0, 30) : ' · ' + String(leido).slice(0, 30)));
    log('getUserDefinedData', fallo ? 'lanzó ' + fallo : JSON.stringify(leido));
    if (!esObjeto) {
        out.push('NO se reescribe: la lectura no dio objeto');
        return;
    }
    const d = leido.impresionPin;
    out.push('impresionPin: ' + (d ? (Array.isArray(d.usuarios) ? d.usuarios.length : '?') + ' usuario(s)' : 'no está'));
    let r = null;
    try {
        r = s.setUserDefinedData(leido);
    } catch (e) {
        out.push('setUserDefinedData: LANZÓ ' + String((e && e.message) || e).slice(0, 30));
        return;
    }
    out.push('setUserDefinedData devuelve: ' + String(r).slice(0, 34));
    let otra = null;
    try {
        otra = s.getUserDefinedData();
    } catch (e) { /* ya se anotó arriba cómo se comporta */ }
    const sigue = otra && typeof otra === 'object' && otra.impresionPin;
    out.push('tras reescribir, los datos ' + (sigue ? 'siguen ahí' : 'NO ESTÁN'));
    log('setUserDefinedData', 'devolvió ' + r + ' · tras releer: ' + JSON.stringify(otra && otra.impresionPin ? nombres(otra.impresionPin) : otra));
}

/** Todo lo que hace falta saber para respaldar los datos, en una sola pulsación. */
export function probarDatos() {
    const out = [];
    probarMemoriaApp(out);
    probarObjectSave(out);

    const g = globalThis;
    const globalesDatos = nombres(g).filter((k) => INTERES_DATOS.test(k));
    log('globales de datos/ficheros', globalesDatos.join(',') || 'ninguna');
    out.push('Globales fichero: ' + (globalesDatos.join(',').slice(0, 46) || 'ninguna'));

    const hallados = buscarPorNombre(g.pedk, INTERES_DATOS);
    log('pedk: datos/ficheros', hallados.join(' | ') || 'nada');
    out.push('En pedk: ' + hallados.length + ' coincidencia(s)');

    // getFileList: la doc lo cita como reemplazo de getAllAppSettingValue y luego no
    // lo documenta. Si existe, puede ser la única vía a ficheros (¿y a una flash?).
    const listar = buscarPorNombre(g.pedk, /getFileList|getAllAppSetting/i);
    out.push('getFileList: ' + (listar.join(',') || 'no aparece'));
    log('getFileList', listar.join(' | ') || 'no aparece en pedk');

    out.push('Detalle en el log: [explorar]');
    return out;
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
