/**
 * RESPALDO POR RED: sacar los datos del equipo y volver a meterlos.
 *
 * Por qué por red y no por una flash: medido el 17-09-2026 en la BM5220ADW, la app NO
 * tiene acceso a ficheros de una flash USB. Del USB sólo se exponen interruptores
 * (`setUsbHostEnable`, `FUNC_T_UDISK_*`), `pedk.usbh` no trae API de ficheros y
 * `getFileList` no existe. Lo que sí hay es HTTP: `pedk.net.http.fetchData` hace POST
 * con cuerpo JSON y GET devolviendo el cuerpo ya parseado.
 *
 * Al otro lado tiene que haber un PC de la misma red escuchando. Ese programa está en
 * `herramientas/respaldo-servidor.py` y atiende las dos rutas:
 *
 *   POST http://IP:8099/respaldo       ← el equipo manda TODO (usuarios y contadores)
 *   GET  http://IP:8099/usuarios.json  ← el equipo lee los usuarios a dar de alta
 *
 * En el panel sólo se teclea la IP: el puerto y las rutas son fijos porque el teclado
 * de texto no tiene ':' ni '/'.
 *
 * AVISO: el respaldo lleva las huellas de los PIN, y una huella de 4 dígitos se rompe
 * probando las 10.000. El fichero vale lo mismo que la lista de PIN en claro; el
 * servidor lo guarda en una carpeta que conviene tratar como tal.
 */
import { config } from './config.js';
import * as store from './store.js';

function http() {
    return (globalThis.pedk && pedk.net && pedk.net.http) || null;
}

export function disponible() {
    const h = http();
    return !!(h && typeof h.fetchData === 'function' && typeof h.Request === 'function');
}

/** La IP configurada, o null si el respaldo está apagado. */
export function destino() {
    return store.ajustes().respaldoIp || null;
}

/** Acepta 1.2.3.4; no vale un nombre de máquina porque el teclado no tiene letras… */
export function ipValida(texto) {
    const t = String(texto || '');
    const partes = t.split('.');
    if (partes.length !== 4) {
        return false;
    }
    return partes.filter((p) => /^[0-9]{1,3}$/.test(p) && Number(p) <= 255).length === 4;
}

export function fijarDestino(ip) {
    if (ip === null || ip === '') {
        store.cambiarAjuste('respaldoIp', null);
        return true;
    }
    if (!ipValida(ip)) {
        return false;
    }
    store.cambiarAjuste('respaldoIp', String(ip));
    return true;
}

function url(ruta) {
    return 'http://' + destino() + ':' + config.RESPALDO_PUERTO + ruta;
}

/* ------------------------------------------------------------------ */
/* Estado del último intento, para enseñarlo en el panel                */
/* ------------------------------------------------------------------ */

let ultimo = { cuando: null, ok: null, detalle: 'todavía no se ha respaldado' };
/** Revisión de los datos que ya se mandó bien: evita repetir el mismo envío. */
let revisionEnviada = -1;
let enCurso = false;

export function estado() {
    return { ultimo, revisionEnviada, enCurso, destino: destino() };
}

function anotar(ok, detalle) {
    ultimo = { cuando: new Date().toISOString().slice(0, 19).replace('T', ' '), ok, detalle };
    console.log('[respaldo] ' + (ok ? 'ok: ' : 'FALLÓ: ') + detalle);
}

/* ------------------------------------------------------------------ */
/* Exportar                                                             */
/* ------------------------------------------------------------------ */

/**
 * Manda TODO al PC. No espera: avisa por `alTerminar` cuando el equipo contesta.
 *
 * Ojo con el `error` del callback: la doc del SDK dice que ahí llega también el caso
 * bueno ("200 OK"), así que lo que manda es `resp.code`, no que `error` esté vacío.
 *
 * @param {function({ok: boolean, detalle: string})} [alTerminar]
 */
export function exportar(alTerminar) {
    const avisar = (ok, detalle) => {
        enCurso = false;
        anotar(ok, detalle);
        if (alTerminar) {
            try { alTerminar({ ok, detalle }); } catch (e) { /* al panel no le importa */ }
        }
    };
    if (!destino()) {
        avisar(false, 'sin IP configurada');
        return false;
    }
    const h = http();
    if (!disponible()) {
        avisar(false, 'este firmware no trae pedk.net.http');
        return false;
    }
    if (enCurso) {
        return false;
    }
    const datos = store.respaldo();
    const revision = datos.revision;
    enCurso = true;
    try {
        const cab = new h.Headers('Content-Type', 'application/json');
        const req = new h.Request(url(config.RESPALDO_RUTA_SUBIR), 'POST', cab, new h.RequestBody(datos));
        h.fetchData(req, (error, resp) => {
            const codigo = resp && resp.code;
            if (codigo >= 200 && codigo < 300) {
                revisionEnviada = revision;
                avisar(true, datos.usuarios.length + ' usuario(s) enviados a ' + destino());
            } else {
                avisar(false, 'el PC respondió ' + (codigo || String(error).slice(0, 30)));
            }
        });
    } catch (e) {
        avisar(false, String((e && e.message) || e).slice(0, 40));
        return false;
    }
    return true;
}

/* ------------------------------------------------------------------ */
/* Importar                                                             */
/* ------------------------------------------------------------------ */

/**
 * Lee los usuarios del PC y los da de alta. No borra a nadie: actualiza los que ya
 * existen y crea los que faltan (ver store.restaurarUsuarios).
 *
 * @param {function({ok: boolean, detalle: string})} [alTerminar]
 */
export function importar(alTerminar) {
    const avisar = (ok, detalle) => {
        enCurso = false;
        anotar(ok, detalle);
        if (alTerminar) {
            try { alTerminar({ ok, detalle }); } catch (e) { /* idem */ }
        }
    };
    if (!destino()) {
        avisar(false, 'sin IP configurada');
        return false;
    }
    const h = http();
    if (!disponible()) {
        avisar(false, 'este firmware no trae pedk.net.http');
        return false;
    }
    if (enCurso) {
        return false;
    }
    enCurso = true;
    try {
        const cab = new h.Headers('Accept', 'application/json');
        const req = new h.Request(url(config.RESPALDO_RUTA_USUARIOS), 'GET', cab, null);
        h.fetchData(req, (error, resp) => {
            const codigo = resp && resp.code;
            if (!(codigo >= 200 && codigo < 300)) {
                avisar(false, 'el PC respondió ' + (codigo || String(error).slice(0, 30)));
                return;
            }
            let datos = resp.body;
            // Según el firmware, el cuerpo puede llegar ya parseado o como texto.
            if (typeof datos === 'string') {
                try {
                    datos = JSON.parse(datos);
                } catch (e) {
                    avisar(false, 'el fichero no es JSON válido');
                    return;
                }
            }
            const r = store.restaurarUsuarios(datos);
            if (!r.ok) {
                avisar(false, r.error || 'ningún usuario válido en el fichero');
                return;
            }
            avisar(true, r.creados + ' nuevo(s), ' + r.actualizados + ' actualizado(s)'
                + (r.malos ? ', ' + r.malos + ' mal escrito(s)' : ''));
        });
    } catch (e) {
        avisar(false, String((e && e.message) || e).slice(0, 40));
        return false;
    }
    return true;
}

/* ------------------------------------------------------------------ */
/* Respaldo automático                                                  */
/* ------------------------------------------------------------------ */

let temporizador = null;

/**
 * Respalda cada `RESPALDO_AUTO_MS` mientras haya IP y algo nuevo que mandar. Si el PC
 * está apagado, falla en silencio y se reintenta a la vuelta siguiente: el respaldo
 * no puede estorbar a quien está imprimiendo.
 */
export function automatico() {
    detener();
    const vuelta = () => {
        temporizador = setTimeout(vuelta, config.RESPALDO_AUTO_MS);
        if (!destino() || store.estado().soloLectura) {
            return;
        }
        if (store.revisionActual() === revisionEnviada) {
            return;                     // nada cambió desde el último respaldo bueno
        }
        exportar(null);
    };
    temporizador = setTimeout(vuelta, config.RESPALDO_ESPERA_INICIAL_MS);
}

export function detener() {
    if (temporizador !== null) {
        clearTimeout(temporizador);
        temporizador = null;
    }
}
